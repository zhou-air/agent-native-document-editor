import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { uid, assignIds, block, plain } from "./content.js";
import { DEFAULT_EXPORT_TEMPLATE } from "./docx-export.js";

const children = (n, name) => Array.from(n?.childNodes || []).filter(x => x.nodeType === 1 && (!name || x.localName === name));
const child = (n, name) => children(n, name)[0];
const all = (n, name) => Array.from(n?.getElementsByTagName("*") || []).filter(x => x.localName === name);
const attr = (n, name) => n?.getAttribute("w:" + name) || n?.getAttribute(name) || null;
const val = n => attr(n, "val");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safeLink = href => /^(https?:\/\/|mailto:|#)/i.test(href || "");
const truth = n => n ? !["0", "false", "off"].includes(val(n)) : undefined;

/** Word is an import boundary, never the persistent content model. */
export async function importDocx(buffer, name = "导入文档") {
  const zip = await JSZip.loadAsync(buffer);
  if (Object.values(zip.files).reduce((n, f) => n + (f._data?.uncompressedSize || 0), 0) > 150 * 1024 * 1024)
    throw Error("DOCX 解压内容超过 150 MB 限制");
  const warnings = [], idMappings = [];
  const warn = message => { if (!warnings.includes(message)) warnings.push(message); };
  async function read(file) {
    if (!zip.file(file)) return null;
    return new DOMParser({ onError: (level, message) => { if (level === "fatalError") throw Error(`DOCX XML 无效：${file}：${message}`); } }).parseFromString(await zip.file(file).async("string"), "text/xml");
  }
  const doc = await read("word/document.xml");
  if (!doc || !child(doc.documentElement, "body")) throw Error("无效 DOCX：缺少 word/document.xml 正文");
  const [styleDoc, numDoc, relDoc] = await Promise.all([read("word/styles.xml"), read("word/numbering.xml"), read("word/_rels/document.xml.rels")]);
  const rels = Object.fromEntries(all(relDoc, "Relationship").map(r => [r.getAttribute("Id"), { target: r.getAttribute("Target"), external: r.getAttribute("TargetMode") === "External" }]));
  let metadata = null;
  for (const file of Object.keys(zip.files).filter(p => /^customXml\/item\d+\.xml$/.test(p))) {
    const data = await read(file);
    if (data?.documentElement?.namespaceURI !== "urn:agent-document:identity:v2") continue;
    try {
      const candidate = JSON.parse(data.documentElement.textContent);
      if (candidate.formatVersion !== 2 || !Array.isArray(candidate.sections) || typeof candidate.blocks !== "object" || !candidate.blocks) throw Error("结构不正确");
      metadata = candidate;
    } catch { warn("Agent Document 身份元数据损坏，已重新生成身份；DOCX 正文仍正常提取。"); }
    break;
  }
  const usedIds = new Set();
  function identity(candidate, kind) {
    const valid = typeof candidate === "string" && UUID.test(candidate) && !usedIds.has(candidate);
    const id = valid ? candidate : uid(); usedIds.add(id);
    if (candidate && !valid) { idMappings.push({ kind, oldId: candidate, newId: id }); warn("检测到重复或无效稳定 ID，已生成新 ID；映射保存在 idMappings 中。"); }
    return id;
  }
  const documentId = identity(metadata?.id, "document");
  const definitions = new Map();
  function runMarks(r) {
    const result = {};
    for (const [tag, key] of [["b", "bold"], ["i", "italic"], ["strike", "strike"]]) {
      const value = truth(child(r, tag)); if (value !== undefined) result[key] = value;
    }
    if (child(r, "u")) result.underline = !["none", "0", "false"].includes(val(child(r, "u")));
    if (child(r, "vertAlign")) result.vertical = val(child(r, "vertAlign"));
    return result;
  }
  for (const s of all(styleDoc, "style")) definitions.set(attr(s, "styleId"), {
    name: val(child(s, "name")), basedOn: val(child(s, "basedOn")), outline: val(child(child(s, "pPr"), "outlineLvl")),
    marks: runMarks(child(s, "rPr")), numPr: child(child(s, "pPr"), "numPr"),
  });
  function effective(id, seen = new Set()) {
    if (!id || seen.has(id)) return {}; seen.add(id);
    const s = definitions.get(id); return s ? { ...effective(s.basedOn, seen), ...s.marks } : {};
  }
  function headingLevel(id, seen = new Set()) {
    if (!id || seen.has(id)) return null; seen.add(id);
    const s = definitions.get(id); if (!s) return null;
    if (s.outline !== null) return Number(s.outline) < 9 ? Number(s.outline) + 1 : null;
    const match = (s.name || id).match(/^(?:heading\s*|标题\s*)([1-9])$/i);
    return match ? Number(match[1]) : headingLevel(s.basedOn, seen);
  }
  function styleNumbering(id, seen = new Set()) {
    if (!id || seen.has(id)) return null; seen.add(id);
    const s = definitions.get(id); return s?.numPr || styleNumbering(s?.basedOn, seen);
  }
  const defaultStyle = all(styleDoc, "style").find(s => attr(s, "type") === "paragraph" && attr(s, "default") === "1");
  const defaultStyleId = attr(defaultStyle, "styleId") || "Normal";
  const abstracts = {}, nums = {}, counters = {};
  for (const a of all(numDoc, "abstractNum")) abstracts[attr(a, "abstractNumId")] = Object.fromEntries(children(a, "lvl").map(l => [attr(l, "ilvl"), { format: val(child(l, "numFmt")), text: val(child(l, "lvlText")), start: Number(val(child(l, "start")) || 1) }]));
  for (const n of all(numDoc, "num")) {
    const id = attr(n, "numId"); nums[id] = structuredClone(abstracts[val(child(n, "abstractNumId"))] || {});
    for (const override of children(n, "lvlOverride")) {
      const il = attr(override, "ilvl"); nums[id][il] ||= { format: "decimal", text: "%1.", start: 1 };
      if (child(override, "startOverride")) nums[id][il].start = Number(val(child(override, "startOverride")));
    }
  }
  function numbering(p, sid) {
    const n = child(child(p, "pPr"), "numPr") || styleNumbering(sid); if (!n) return null;
    const id = val(child(n, "numId")), level = Number(val(child(n, "ilvl")) || 0), def = nums[id]?.[level];
    if (id === "0") return null;
    if (!def) { warn("部分编号定义无法解析，已保留文字；请对照归档原件核验编号。"); return null; }
    counters[id] ||= {}; const counter = counters[id]; counter[level] = counter[level] == null ? def.start : counter[level] + 1;
    for (const k of Object.keys(counter)) if (Number(k) > level) delete counter[k];
    function format(i) {
      const v = counter[i] ?? nums[id]?.[i]?.start ?? 1, type = nums[id]?.[i]?.format;
      if (["lowerLetter", "upperLetter"].includes(type)) { let result = "", value = v; while (value > 0) { value--; result = String.fromCharCode((type === "lowerLetter" ? 97 : 65) + value % 26) + result; value = Math.floor(value / 26); } return result; }
      if (type && !["decimal", "bullet"].includes(type)) warn(`编号格式 ${type} 暂转换为十进制显示，请核验编号。`);
      return String(v);
    }
    return { value: counter[level], level, format: def.format, label: (def.text || "%1.").replace(/%(\d)/g, (_, index) => format(Number(index) - 1)) };
  }
  const assets = {}, imageMap = {}, assetTargets = new Map();
  for (const [id, rel] of Object.entries(rels)) {
    if (rel.external) continue;
    const target = path.posix.normalize(rel.target.startsWith("/") ? rel.target.slice(1) : path.posix.join("word", rel.target));
    if (!/^word\/.+\.(png|jpe?g|gif|webp|bmp|tiff?|svg|emf|wmf)$/i.test(target)) continue;
    if (assetTargets.has(target)) { imageMap[id] = assetTargets.get(target); continue; }
    if (!zip.file(target)) { warn(`图片关系 ${id} 的资源缺失：${target}`); continue; }
    const ext = target.split(".").at(-1).toLowerCase(), candidate = metadata?.assets?.[target];
    const dest = /^assets\/[\w.-]+$/.test(candidate || "") && !assets[candidate] ? candidate : `assets/${uid()}.${ext}`;
    assets[dest] = await zip.file(target).async("nodebuffer"); imageMap[id] = dest; assetTargets.set(target, dest);
    if (!["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)) warn(`图片格式 ${ext} 可能无法显示，资源已保留并可继续导出。`);
  }
  function images(t) {
    const result = [], ids = [...all(t, "blip").map(b => b.getAttribute("r:embed")), ...all(t, "imagedata").map(b => b.getAttribute("r:id"))].filter(Boolean);
    for (const id of new Set(ids)) {
      if (!imageMap[id]) { warn(`绘图图片 ${id} 无法解析，原始 DOCX 已归档。`); continue; }
      const extent = all(t, "extent")[0], description = all(t, "docPr")[0];
      result.push({ type: "image", attrs: { src: imageMap[id], alt: description?.getAttribute("descr") || "导入图片", ...(extent ? { width: Math.round(Number(extent.getAttribute("cx")) / 9525), height: Math.round(Number(extent.getAttribute("cy")) / 9525) } : {}) } });
    }
    if (!ids.length && !all(t, "txbxContent").length) warn("存在无法转换的绘图对象，原始 DOCX 已归档。");
    return result;
  }
  function runs(p, style) {
    const output = [];
    function walk(n, link = null) {
      for (const c of children(n)) {
        if (c.localName === "hyperlink") {
          const href = rels[c.getAttribute("r:id")]?.target || (attr(c, "anchor") ? `#${attr(c, "anchor")}` : null);
          if (href && !safeLink(href)) warn("不支持的链接协议已移除，链接文字已保留。");
          walk(c, safeLink(href) ? href : null);
        } else if (c.localName === "r") {
          const pr = child(c, "rPr"), rs = val(child(pr, "rStyle")), props = { ...effective(style), ...effective(rs), ...runMarks(pr) };
          const marks = ["bold", "italic", "underline", "strike"].filter(k => props[k]).map(type => ({ type }));
          if (["superscript", "subscript"].includes(props.vertical)) marks.push({ type: props.vertical });
          if (link) marks.push({ type: "link", attrs: { href: link } });
          const text = value => { if (value) output.push({ type: "text", text: value, ...(marks.length ? { marks } : {}) }); };
          for (const t of children(c)) {
            if (["t", "delText"].includes(t.localName)) text(t.textContent);
            else if (t.localName === "tab") text("\t");
            else if (["br", "cr"].includes(t.localName)) output.push({ type: "hardBreak" });
            else if (t.localName === "noBreakHyphen") text("‑");
            else if (t.localName === "softHyphen") text("\u00ad");
            else if (["drawing", "pict", "object"].includes(t.localName)) {
              output.push(...images(t));
              if (t.localName === "object") warn("检测到 OLE 嵌入对象：保留可提取预览图，原生对象编辑能力仅在归档 DOCX 中保留。");
              for (const box of all(t, "txbxContent")) { warn("文本框文字已提取到正文，原浮动布局不保留。"); for (const item of all(box, "p")) { walk(item, link); output.push({ type: "hardBreak" }); } }
            } else if (t.localName === "sym") {
              const code = parseInt(attr(t, "char"), 16); if (Number.isFinite(code)) text(String.fromCodePoint(code));
              warn("检测到字体符号，已保留字符码；字体相关符号显示需核验。");
            } else if (!["rPr", "instrText", "fldChar", "lastRenderedPageBreak", "footnoteReference", "endnoteReference", "commentReference"].includes(t.localName)) {
              if (t.textContent) text(t.textContent);
              warn(`行内对象 ${t.localName} 已按可提取文字降级，请核验归档原件。`);
            }
          }
        } else if (["ins", "del", "sdt", "sdtContent", "smartTag", "customXml", "fldSimple"].includes(c.localName)) {
          if (["ins", "del"].includes(c.localName)) warn("修订中的新增和删除文字均已提取，需人工决定修订接受状态。");
          if (c.localName === "fldSimple") warn("Word 域已保留当前显示文字，不保留动态更新能力。");
          walk(c, link);
        } else if (["oMath", "oMathPara"].includes(c.localName)) {
          const fallback = all(c, "t").map(t => t.textContent).join("");
          if (fallback) output.push({ type: "text", text: fallback });
          warn("公式已提取可读文字，二维公式结构未转换；请核验归档原件。");
        } else if (!["pPr", "bookmarkStart", "bookmarkEnd", "proofErr", "sdtPr", "sdtEndPr", "commentRangeStart", "commentRangeEnd", "permStart", "permEnd"].includes(c.localName)) {
          if (c.textContent) { warn(`段落对象 ${c.localName} 已递归提取文字，请核验。`); walk(c, link); }
        }
      }
    }
    walk(p); return output;
  }
  function paragraph(p, allowHeading = true) {
    const pp = child(p, "pPr"), sid = val(child(pp, "pStyle")) || defaultStyleId;
    const explicit = val(child(pp, "outlineLvl")), lev = explicit !== null ? (Number(explicit) < 9 ? Number(explicit) + 1 : null) : headingLevel(sid);
    const number = numbering(p, sid), inline = runs(p, sid), nodes = []; let pending = [];
    const flush = () => { if (pending.length || !nodes.length) { nodes.push({ type: allowHeading && lev ? "heading" : "paragraph", ...(allowHeading && lev ? { attrs: { level: lev } } : {}), content: pending }); pending = []; } };
    if (number && lev && number.format !== "bullet" && !inline.map(n => n.text || "").join("").startsWith(number.label)) pending.push({ type: "text", text: number.label + " " });
    for (const item of inline) { if (item.type === "image") { if (pending.length) flush(); nodes.push(item); } else pending.push(item); }
    if (pending.length || !nodes.length) flush();
    if (number && !lev) {
      if (number.level > 0) warn("多级列表已保留文字与编号值，原复杂层级需核验。");
      return { nodes: [{ type: number.format === "bullet" ? "bulletList" : "orderedList", attrs: number.format === "bullet" ? {} : { start: number.value }, content: [{ type: "listItem", content: nodes }] }], level: null };
    }
    return { nodes, level: allowHeading ? lev : null };
  }
  function cellContents(tc) {
    const content = [];
    for (const c of children(tc)) {
      if (c.localName === "p") content.push(...paragraph(c, false).nodes);
      else if (c.localName === "tbl") content.push(table(c));
      else if (["sdt", "sdtContent", "customXml"].includes(c.localName)) content.push(...cellContents(c));
      else if (!["tcPr", "sdtPr", "sdtEndPr"].includes(c.localName)) warn(`单元格对象 ${c.localName} 未完全转换，请核验归档原件。`);
    }
    return content.length ? content : [{ type: "paragraph", content: [] }];
  }
  const hasMeaning = node => node.type === "image" || node.type === "table" || (node.type === "text" ? !!node.text : (node.content || []).some(hasMeaning));
  function table(t) {
    const rows = [], active = new Map();
    for (const tr of children(t, "tr")) {
      const cells = [], next = new Map(); let col = Number(val(child(child(tr, "trPr"), "gridBefore")) || 0);
      if (col) { warn("表格省略的起始网格已补空单元格。"); for (let i = 0; i < col; i++) cells.push({ type: "tableCell", attrs: { colspan: 1, rowspan: 1 }, content: [{ type: "paragraph", content: [] }] }); }
      for (const tc of children(tr, "tc")) {
        const pr = child(tc, "tcPr"), span = Math.max(1, Number(val(child(pr, "gridSpan")) || 1)), vm = child(pr, "vMerge"), continuation = vm && val(vm) !== "restart", content = cellContents(tc);
        if (child(pr, "hMerge")) warn("检测到旧式 hMerge 横向合并：单元格文字均保留，合并结构需人工核验。");
        const above = continuation ? active.get(col) : null;
        if (above && above.attrs.colspan === span) {
          above.attrs.rowspan++;
          const meaningful = content.filter(hasMeaning); if (meaningful.length) { above.content.push(...meaningful); warn("纵向合并续接单元格含正文，已并入主单元格以防丢失。"); }
          for (let j = 0; j < span; j++) next.set(col + j, above);
        } else {
          if (continuation) warn("不规则纵向合并已拆为独立单元格，全部正文保留，请核验表格结构。");
          const cell = { type: child(child(tr, "trPr"), "tblHeader") ? "tableHeader" : "tableCell", attrs: { colspan: span, rowspan: 1 }, content }; cells.push(cell);
          if (vm) for (let j = 0; j < span; j++) next.set(col + j, cell);
        }
        col += span;
      }
      const after = Number(val(child(child(tr, "trPr"), "gridAfter")) || 0);
      if (after) { warn("表格省略的末尾网格已补空单元格。"); for (let i = 0; i < after; i++) cells.push({ type: "tableCell", attrs: { colspan: 1, rowspan: 1 }, content: [{ type: "paragraph", content: [] }] }); }
      rows.push({ type: "tableRow", content: cells }); active.clear(); for (const [k, v] of next) active.set(k, v);
    }
    return { type: "table", content: rows };
  }
  const parsed = [];
  function readBody(container, taggedId = null) {
    const start = parsed.length;
    for (const element of children(container)) {
      if (element.localName === "p") { const value = paragraph(element); for (const n of value.nodes) parsed.push({ node: n, level: n.type === "heading" ? value.level : null, candidate: null }); }
      else if (element.localName === "tbl") parsed.push({ node: table(element), level: null, candidate: null });
      else if (element.localName === "sdt") {
        const tag = val(child(child(element, "sdtPr"), "tag"));
        if (tag === "agent-document:list-item") {
          const itemStart = parsed.length;
          readBody(child(element, "sdtContent") || element);
          const nodes = parsed.splice(itemStart).flatMap((p, i) => i === 0 && ["orderedList", "bulletList"].includes(p.node.type) ? p.node.content.flatMap(item => item.content) : [p.node]);
          parsed.push({ node: { type: "listItem", content: nodes }, level: null, candidate: null });
        } else readBody(child(element, "sdtContent") || element, tag?.startsWith("agent-document:block:") ? tag.slice("agent-document:block:".length) : null);
      } else if (["sdtContent", "customXml", "ins", "del"].includes(element.localName)) { if (["ins", "del"].includes(element.localName)) warn("正文包含修订，新增与删除内容均已提取，请核验。"); readBody(element); }
      else if (!["sectPr", "bookmarkStart", "bookmarkEnd", "sdtPr", "sdtEndPr", "proofErr"].includes(element.localName)) {
        warn(`正文对象 ${element.localName} 未完全转换，已尝试提取其中段落，原始 DOCX 已归档。`);
        if (children(element).length) readBody(element);
        else if (element.textContent) parsed.push({ node: { type: "paragraph", content: [{ type: "text", text: element.textContent }] }, level: null, candidate: null });
      }
    }
    if (taggedId && parsed.length > start) {
      const meta = metadata?.blocks?.[taggedId];
      if (["orderedList", "bulletList"].includes(meta?.type)) {
        const items = parsed.splice(start).flatMap(p => p.node.type === "listItem" ? [p.node] : p.node.type === meta.type ? p.node.content : [{ type: "listItem", content: [p.node] }]);
        parsed.push({ node: { type: meta.type, ...(meta.type === "orderedList" ? { attrs: { start: meta.start || 1 } } : {}), content: items }, level: null, candidate: taggedId });
      } else if (meta?.type === "blockquote") {
        const content = parsed.splice(start).map(p => p.node); parsed.push({ node: { type: "blockquote", content }, level: null, candidate: taggedId });
      } else {
        parsed[start].candidate = taggedId;
        if (parsed.length === start + 1 && ["codeBlock", "horizontalRule"].includes(meta?.type)) parsed[start].node = meta.type === "horizontalRule" ? { type: "horizontalRule" } : { ...parsed[start].node, type: "codeBlock" };
        if (parsed.length > start + 1) warn("一个带身份的 Word 内容控件被拆成多个块：首块保留 ID，其余块生成新 ID。");
      }
    }
  }
  readBody(child(doc.documentElement, "body"));
  for (const tag of ["footnoteReference", "endnoteReference", "fldChar", "altChunk", "commentRangeStart", "object"]) if (all(doc, tag).length) warn(`检测到 ${tag}，未完全转换其交互或附加内容，需核验归档 DOCX。`);
  for (const file of Object.keys(zip.files).filter(p => /^word\/(?:header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(p))) {
    const part = await read(file);
    if (all(part, "t").some(t => t.textContent.trim()) || all(part, "drawing").length || all(part, "pict").length)
      warn(`${file} 已随原始 DOCX 归档，未并入可编辑正文。`);
  }
  const sections = [], sectionByOriginal = new Map(), sectionMeta = new Map(), headingMeta = new Map();
  for (const s of metadata?.sections || []) if (s && typeof s.id === "string") {
    if (sectionMeta.has(s.id)) { warn("身份元数据包含重复章节 ID；已忽略重复定义并保留正文。"); continue; }
    sectionMeta.set(s.id, s); if (s.headingBlockId) headingMeta.set(s.headingBlockId, s);
  }
  // Identity metadata may restore mixed parent/child placement only while the
  // actual Word structure is unchanged. Word edits always win over stale metadata.
  const expectedOrder = [], expectedLevels = new Map(), visitedMetadata = new Set();
  let validMetadataOrder = !!metadata;
  function expectedEntries(entries, depth) {
    if (!Array.isArray(entries)) { validMetadataOrder = false; return; }
    for (const entry of entries) {
      if (entry.kind === "block") expectedOrder.push(entry.id);
      else if (entry.kind === "section") {
        const section = sectionMeta.get(entry.id);
        if (!section || visitedMetadata.has(entry.id)) { validMetadataOrder = false; continue; }
        visitedMetadata.add(entry.id);
        if (section.headingBlockId) expectedLevels.set(section.headingBlockId, Math.min(9, depth));
        expectedEntries(section.entries, depth + 1);
      } else validMetadataOrder = false;
    }
  }
  expectedEntries(metadata?.rootEntries || [], 1);
  const useStoredStructure = validMetadataOrder && expectedOrder.length === parsed.length && expectedOrder.every((id, i) =>
    parsed[i].candidate === id && parsed[i].node.type === metadata.blocks[id]?.type &&
    (!expectedLevels.has(id) || parsed[i].level === expectedLevels.get(id)));
  if (metadata && !useStoredStructure) warn("Word 中的块顺序或标题结构已变化：按实际正文顺序和标题层级重建章节，仍存在的稳定 ID 继续保留。");
  const rootEntries = [], stack = []; let current = null;
  function makeSection(title, level, original = null) {
    if (original && sectionByOriginal.has(original.id)) return sectionByOriginal.get(original.id);
    const id = identity(original?.id, "section");
    while (stack.length && stack.at(-1).level >= level) stack.pop();
    const parent = useStoredStructure && original ? (original.parentId ? sectionByOriginal.get(original.parentId) : null) : stack.at(-1);
    if (useStoredStructure && original?.parentId && !parent) warn("章节身份元数据的父章节未出现在当前位置，已按顶层章节恢复并保留正文。");
    const section = { id, title, level, parentId: parent?.id || null, headingBlockId: null, revision: original?.revision || 1, blocks: [], entries: [] };
    sections.push(section); if (original) sectionByOriginal.set(original.id, section);
    (parent?.entries || rootEntries).push({ kind: "section", id });
    if (level > 0) stack.push(section); return section;
  }
  function prepareIdentity(node, original, location = "") {
    if (!["text", "doc"].includes(node.type)) { node.attrs ||= {}; node.attrs.id = identity(location === "" ? original : metadata?.blocks?.[original]?.ids?.[location], "node"); }
    for (const [i, c] of (node.content || []).entries()) prepareIdentity(c, original, `${location}/${i}`);
    return node;
  }
  for (const item of parsed) {
    const originalBlock = metadata?.blocks?.[item.candidate], originalSection = sectionMeta.get(originalBlock?.sectionId), heading = headingMeta.get(item.candidate);
    if (item.level || useStoredStructure && heading) {
      const original = heading || (useStoredStructure ? originalSection : null);
      current = makeSection(plain(item.node), item.level || 1, !useStoredStructure && sectionByOriginal.has(original?.id) ? null : original || null);
    } else if (useStoredStructure && originalSection) current = sectionByOriginal.get(originalSection.id) || makeSection("前言", 0, originalSection);
    if (!current) current = makeSection("前言", 0, !useStoredStructure && originalSection && !originalSection.headingBlockId ? originalSection : null);
    const node = prepareIdentity(item.node, item.candidate), b = { ...block(assignIds(node)), revision: originalBlock?.revision || 1, sectionId: current.id, order: current.blocks.length };
    current.blocks.push(b); current.entries.push({ kind: "block", id: b.id });
    if ((item.level || useStoredStructure && heading) && !current.headingBlockId) { current.headingBlockId = b.id; current.title = plain(node); }
  }
  if (useStoredStructure) for (const s of metadata?.sections || []) if (!sectionByOriginal.has(s.id) && !(s.entries || []).some(e => e.kind === "block")) makeSection("空章节", 1, s);
  if (!sections.length) makeSection("正文", 1);
  return { id: documentId, formatVersion: 2, title: metadata?.title || name.replace(/\.docx$/i, ""), revision: metadata?.revision || 1, sections, rootEntries, styles: structuredClone(DEFAULT_EXPORT_TEMPLATE), warnings, idMappings, assets, original: buffer };
}
