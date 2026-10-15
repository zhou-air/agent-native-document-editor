import JSZip from "jszip";
import { escape, uid } from "./content.js";

export const DEFAULT_EXPORT_TEMPLATE = Object.freeze({
  formatVersion: 2,
  semantic: {
    body: { font: { eastAsia: "宋体", latin: "Calibri", sizePt: 12 }, paragraph: { afterPt: 6, line: 360 } },
    headings: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i + 1, {
      font: { eastAsia: "黑体", latin: "Calibri", sizePt: i === 0 ? 20 : i === 1 ? 16 : 14, bold: true },
      paragraph: { beforePt: 12, afterPt: 6 },
    }])),
    table: { font: { eastAsia: "宋体", latin: "Calibri", sizePt: 10.5 }, paragraph: { afterPt: 0 } },
  },
  pages: [{ size: { w: 11906, h: 16838 }, margins: { top: 1417, bottom: 1134, left: 1587, right: 1247 } }],
});

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const relType = (type) => `${R}/${type}`;
const xml = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
const num = (value, fallback, min = 0, max = 100000) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;
const safeLink = (value) => /^(https?:\/\/|mailto:|#)/i.test(value || "");
const nodeOf = (b) => b.node || (b.content?.type ? b.content : { type: b.type, content: b.content || [] });

function propertyXml(rule = {}) {
  const f = rule.font || {}, p = rule.paragraph || {};
  const rPr = `<w:rFonts w:ascii="${escape(f.latin || f.ascii || "Calibri")}" w:hAnsi="${escape(f.latin || f.ascii || "Calibri")}" w:eastAsia="${escape(f.eastAsia || "宋体")}"/><w:sz w:val="${Math.round(num(f.sizePt, 12, 1, 144) * 2)}"/><w:b w:val="${f.bold ? 1 : 0}"/><w:i w:val="${f.italic ? 1 : 0}"/>`;
  const spacing = `<w:spacing w:before="${Math.round(num(p.beforePt, 0) * 20)}" w:after="${Math.round(num(p.afterPt, 0) * 20)}" w:line="${Math.round(num(p.line, 240, 100, 2000))}" w:lineRule="${["exact", "atLeast"].includes(p.lineRule) ? p.lineRule : "auto"}"/>`;
  const alignment = ["left", "right", "center", "both"].includes(p.alignment) ? `<w:jc w:val="${p.alignment}"/>` : "";
  const indent = p.indent && typeof p.indent === "object" ? `<w:ind${["left", "right", "firstLine", "hanging"].filter(k => p.indent[k] != null).map(k => ` w:${k}="${Math.round(num(p.indent[k], 0))}"`).join("")}/>` : "";
  return { rPr, pPr: spacing + alignment + indent };
}

function stylesXml(template) {
  const semantic = template.semantic || DEFAULT_EXPORT_TEMPLATE.semantic;
  const normal = propertyXml(semantic.body || DEFAULT_EXPORT_TEMPLATE.semantic.body);
  let out = `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr>${normal.pPr}</w:pPr><w:rPr>${normal.rPr}</w:rPr></w:style>`;
  for (let i = 1; i <= 9; i++) {
    const rule = propertyXml(semantic.headings?.[i] || DEFAULT_EXPORT_TEMPLATE.semantic.headings[i]);
    out += `<w:style w:type="paragraph" w:styleId="Heading${i}"><w:name w:val="heading ${i}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/>${rule.pPr}<w:outlineLvl w:val="${i - 1}"/></w:pPr><w:rPr>${rule.rPr}</w:rPr></w:style>`;
  }
  const table = propertyXml(semantic.table || DEFAULT_EXPORT_TEMPLATE.semantic.table);
  out += `<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:pPr>${table.pPr}</w:pPr><w:rPr>${table.rPr}</w:rPr></w:style>`;
  return xml(`<w:styles xmlns:w="${W}">${out}</w:styles>`);
}

/** Export semantic content. Only this boundary visits the complete document. */
export async function exportDocx(project, { assetReader, template = project.styles || DEFAULT_EXPORT_TEMPLATE } = {}) {
  const zip = new JSZip(), relationships = [], mediaTypes = new Map(), imageRels = new Map();
  const sections = new Map((project.sections || []).map(s => [s.id, s]));
  const blocks = new Map();
  for (const s of sections.values()) for (const b of s.blocks || []) {
    if (blocks.has(b.id)) throw Error(`导出检测到重复 Block ID：${b.id}`);
    blocks.set(b.id, { ...b, sectionId: s.id });
  }
  const metadata = { formatVersion: 2, id: project.id, title: project.title, revision: project.revision, sections: [], rootEntries: project.rootEntries || [], blocks: {}, assets: {} };
  const relationship = (type, target, external = false) => {
    const id = `rId${relationships.length + 1}`;
    relationships.push({ id, type: relType(type), target, external });
    return id;
  };
  relationship("styles", "styles.xml");
  relationship("customXml", "../customXml/item1.xml");
  let drawingId = 0, controlId = 0, mediaId = 0;
  const numberingDefinitions = [];
  async function image(n) {
    const a = n.attrs || {}, src = a.src;
    if (!/^assets\/[\w.-]+$/.test(src || "")) throw Error(`无效图片资源路径：${src}`);
    let pending = imageRels.get(src);
    if (!pending) {
      const index = ++mediaId;
      pending = (async () => {
        const bytes = assetReader ? await assetReader(src) : project.assets?.[src];
        if (!bytes || !bytes.length) throw Error(`图片资源不存在，已停止导出：${src}`);
        const extension = src.split(".").at(-1).toLowerCase();
        const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp", tif: "image/tiff", tiff: "image/tiff", svg: "image/svg+xml", emf: "image/x-emf", wmf: "image/x-wmf" }[extension];
        if (!mime) throw Error(`无法导出图片格式：${extension}`);
        const target = `media/image${index}.${extension}`;
        zip.file(`word/${target}`, bytes); mediaTypes.set(extension, mime); metadata.assets[`word/${target}`] = src;
        return relationship("image", target);
      })();
      imageRels.set(src, pending);
    }
    const rel = await pending;
    const cx = Math.round(num(a.width, 480, 1, 1200) * 9525), cy = Math.round(num(a.height, num(a.width, 480) * 0.6, 1, 2400) * 9525);
    const id = ++drawingId;
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Image ${id}" descr="${escape(a.alt || "")}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${escape(src)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  }
  async function inline(n) {
    if (n.type === "hardBreak") return "<w:r><w:br/></w:r>";
    if (n.type === "image") return image(n);
    if (n.type !== "text") throw Error(`未支持的行内类型 ${n.type}，已停止导出以防内容丢失`);
    const properties = [];
    const markTags = { bold: "b", italic: "i", underline: "u", strike: "strike" };
    for (const m of n.marks || []) {
      if (markTags[m.type]) properties.push(`<w:${markTags[m.type]}${m.type === "underline" ? ' w:val="single"' : ""}/>`);
      else if (["superscript", "subscript"].includes(m.type)) properties.push(`<w:vertAlign w:val="${m.type}"/>`);
      else if (m.type === "code") properties.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
      else if (m.type !== "link") throw Error(`未支持的行内语义 ${m.type}，已停止导出`);
    }
    const runs = String(n.text || "").split(/(\t|\r?\n)/).filter(Boolean).map(t => t === "\t" ? "<w:tab/>" : /\n/.test(t) ? "<w:br/>" : `<w:t xml:space="preserve">${escape(t)}</w:t>`).join("");
    let result = `<w:r>${properties.length ? `<w:rPr>${properties.join("")}</w:rPr>` : ""}${runs}</w:r>`;
    const href = n.marks?.find(m => m.type === "link")?.attrs?.href;
    if (href) {
      if (!safeLink(href)) throw Error(`不支持的链接协议：${href}`);
      result = href.startsWith("#") ? `<w:hyperlink w:anchor="${escape(href.slice(1))}">${result}</w:hyperlink>` : `<w:hyperlink r:id="${relationship("hyperlink", href, true)}">${result}</w:hyperlink>`;
    }
    return result;
  }
  async function element(n, context = {}) {
    if (["paragraph", "heading", "codeBlock"].includes(n.type)) {
      const level = Math.max(1, Math.min(9, context.level || n.attrs?.level || 1));
      const style = n.type === "heading" ? `Heading${level}` : context.table ? "TableText" : "Normal";
      return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${context.numId ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${context.numId}"/></w:numPr>` : ""}</w:pPr>${(await Promise.all((n.content || []).map(inline))).join("")}</w:p>`;
    }
    if (n.type === "image") return `<w:p>${await image(n)}</w:p>`;
    if (n.type === "horizontalRule") return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4"/></w:pBdr></w:pPr></w:p>';
    if (["orderedList", "bulletList"].includes(n.type)) {
      const numId = numberingDefinitions.length + 1;
      numberingDefinitions.push({ id: numId, start: num(n.attrs?.start, 1, 1), type: n.type });
      let result = "";
      for (const item of n.content || []) {
        let first = true, content = "";
        for (const c of item.content || []) { content += await element(c, { ...context, numId: first ? numId : null }); first = false; }
        result += `<w:sdt><w:sdtPr><w:tag w:val="agent-document:list-item"/><w:id w:val="${++controlId}"/></w:sdtPr><w:sdtContent>${content}</w:sdtContent></w:sdt>`;
      }
      return result;
    }
    if (["blockquote", "listItem"].includes(n.type)) return (await Promise.all((n.content || []).map(c => element(c, context)))).join("");
    if (n.type !== "table") throw Error(`未支持的块类型 ${n.type}，已停止导出以防内容丢失`);
    const grid = [], cells = [];
    for (const [r, row] of (n.content || []).entries()) {
      grid[r] ||= []; let column = 0;
      for (const cell of row.content || []) {
        while (grid[r][column]) column++;
        const width = num(cell.attrs?.colspan, 1, 1, 1000), height = num(cell.attrs?.rowspan, 1, 1, 100000);
        if (!Number.isInteger(width) || !Number.isInteger(height) || r + height > n.content.length) throw Error("表格合并跨度无效，已停止导出");
        const entry = { cell, row: r, col: column, width, height }; cells.push(entry);
        for (let y = r; y < r + height; y++) { grid[y] ||= []; for (let x = column; x < column + width; x++) { if (grid[y][x]) throw Error("表格合并单元格重叠"); grid[y][x] = entry; } }
        column += width;
      }
    }
    const columns = Math.max(1, ...grid.map(row => row.length)); let rows = "";
    for (let r = 0; r < grid.length; r++) {
      let row = "";
      for (let c = 0; c < columns;) {
        const entry = grid[r][c];
        if (!entry) { row += "<w:tc><w:p/></w:tc>"; c++; continue; }
        const continuation = entry.row < r;
        const props = `${entry.width > 1 ? `<w:gridSpan w:val="${entry.width}"/>` : ""}${entry.height > 1 ? `<w:vMerge${continuation ? "" : ' w:val="restart"'}/>` : ""}`;
        let content = continuation ? "<w:p/>" : (await Promise.all((entry.cell.content || []).map(child => element(child, { table: true })))).join("");
        if (!content.endsWith("</w:p>")) content += "<w:p/>";
        row += `<w:tc>${props ? `<w:tcPr>${props}</w:tcPr>` : ""}${content}</w:tc>`; c += entry.width;
      }
      rows += `<w:tr>${row}</w:tr>`;
    }
    const borders = ["top", "left", "bottom", "right", "insideH", "insideV"].map(side => `<w:${side} w:val="single" w:sz="4" w:color="808080"/>`).join("");
    return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr><w:tblGrid>${Array.from({ length: columns }, () => '<w:gridCol w:w="1800"/>').join("")}</w:tblGrid>${rows}</w:tbl>`;
  }
  const seenSections = new Set(), seenBlocks = new Set();
  const order = [];
  function visitBlock(id, section, depth) {
    if (seenBlocks.has(id)) throw Error(`Block 出现在多个位置：${id}`);
    const b = blocks.get(id); if (!b) throw Error(`Block 不存在：${id}`);
    seenBlocks.add(id); order.push({ b, depth, section });
  }
  function visitSection(id, depth) {
    if (seenSections.has(id)) throw Error(`章节重复或存在循环：${id}`);
    const s = sections.get(id); if (!s) throw Error(`章节不存在：${id}`);
    seenSections.add(id);
    const headingBlockId = s.headingBlockId || s.blocks?.find(b => b.type === "heading")?.id || null;
    const entries = s.entries || [...(s.blocks || []).map(b => ({ kind: "block", id: b.id })), ...[...sections.values()].filter(c => c.parentId === id).map(c => ({ kind: "section", id: c.id }))];
    metadata.sections.push({ id, parentId: s.parentId || null, headingBlockId, revision: s.revision || 1, entries });
    for (const entry of entries) {
      if (entry.kind === "section") visitSection(entry.id, depth + 1);
      else if (entry.kind === "block") visitBlock(entry.id, s, depth);
      else throw Error(`未知章节顺序条目：${entry.kind}`);
    }
  }
  const roots = project.rootEntries?.length ? project.rootEntries : [...sections.values()].filter(s => !s.parentId).map(s => ({ kind: "section", id: s.id }));
  metadata.rootEntries = roots;
  for (const entry of roots) { if (entry.kind !== "section") throw Error("文档根节点必须是章节"); visitSection(entry.id, 1); }
  if (seenSections.size !== sections.size || seenBlocks.size !== blocks.size) throw Error("文档存在未归属的章节或 Block，已停止导出以防遗漏");
  let body = "";
  for (const { b, depth, section } of order) {
    const n = nodeOf(b), ids = {};
    function identity(node, location = "") { if (node.attrs?.id) ids[location] = node.attrs.id; for (const [i, c] of (node.content || []).entries()) identity(c, `${location}/${i}`); }
    identity(n);
    metadata.blocks[b.id] = { sectionId: section.id, revision: b.revision || 1, type: n.type, ...(n.type === "orderedList" ? { start: n.attrs?.start || 1 } : {}), ids };
    body += `<w:sdt><w:sdtPr><w:alias w:val="Agent Document Block"/><w:tag w:val="agent-document:block:${escape(b.id)}"/><w:id w:val="${++controlId}"/></w:sdtPr><w:sdtContent>${await element(n, { level: depth })}</w:sdtContent></w:sdt>`;
  }
  const page = template.pages?.[0] || DEFAULT_EXPORT_TEMPLATE.pages[0], size = page.size || {}, margins = page.margins || {};
  body += `<w:sectPr><w:pgSz w:w="${num(size.w, 11906)}" w:h="${num(size.h, 16838)}"/><w:pgMar${["top", "bottom", "left", "right"].map(side => ` w:${side}="${num(margins[side], 1417)}"`).join("")} w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`;
  zip.file("word/document.xml", xml(`<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}</w:body></w:document>`));
  zip.file("word/styles.xml", stylesXml(template));
  if (numberingDefinitions.length) {
    relationship("numbering", "numbering.xml");
    zip.file("word/numbering.xml", xml(`<w:numbering xmlns:w="${W}">${numberingDefinitions.map(d => `<w:abstractNum w:abstractNumId="${d.id}"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="${d.start}"/><w:numFmt w:val="${d.type === "bulletList" ? "bullet" : "decimal"}"/><w:lvlText w:val="${d.type === "bulletList" ? "•" : "%1."}"/></w:lvl></w:abstractNum>`).join("")}${numberingDefinitions.map(d => `<w:num w:numId="${d.id}"><w:abstractNumId w:val="${d.id}"/></w:num>`).join("")}</w:numbering>`));
  }
  zip.file("customXml/item1.xml", xml(`<ad:document xmlns:ad="urn:agent-document:identity:v2">${escape(JSON.stringify(metadata))}</ad:document>`));
  zip.file("customXml/itemProps1.xml", xml(`<ds:datastoreItem ds:itemID="{${uid().toUpperCase()}}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"><ds:schemaRefs><ds:schemaRef ds:uri="urn:agent-document:identity:v2"/></ds:schemaRefs></ds:datastoreItem>`));
  zip.file("customXml/_rels/item1.xml.rels", xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/customXmlProps" Target="itemProps1.xml"/></Relationships>`));
  zip.file("word/_rels/document.xml.rels", xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.map(r => `<Relationship Id="${r.id}" Type="${r.type}" Target="${escape(r.target)}"${r.external ? ' TargetMode="External"' : ""}/>`).join("")}</Relationships>`));
  zip.file("_rels/.rels", xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`));
  zip.file("[Content_Types].xml", xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...mediaTypes].map(([ext, mime]) => `<Default Extension="${ext}" ContentType="${mime}"/>`).join("")}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>${numberingDefinitions.length ? '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' : ""}<Override PartName="/customXml/itemProps1.xml" ContentType="application/vnd.openxmlformats-officedocument.customXmlProperties+xml"/></Types>`));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
