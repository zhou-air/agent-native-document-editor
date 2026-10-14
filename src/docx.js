import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { uid, assignIds, block, plain } from "./content.js";
const xml = new XMLSerializer();
const children = (n, name) =>
  [...Array.from(n?.childNodes || [])].filter(
    (x) => x.nodeType === 1 && (!name || x.localName === name),
  );
const child = (n, name) => children(n, name)[0];
const all = (n, name) =>
  Array.from(n?.getElementsByTagName("*") || []).filter(
    (x) => x.localName === name,
  );
const attr = (n, name) =>
  n?.getAttribute("w:" + name) || n?.getAttribute(name) || null;
const val = (n) => attr(n, "val");
function obj(n) {
  if (!n) return null;
  const o = {};
  for (const a of Array.from(n.attributes || [])) o[a.localName] = a.value;
  for (const c of children(n)) {
    const k = c.localName;
    if (o[k]) o[k] = [o[k], obj(c)];
    else o[k] = obj(c);
  }
  return o;
}
function props(p, r) {
  const rf = child(r, "rFonts"),
    spacing = child(p, "spacing"),
    indent = child(p, "ind");
  return {
    font: {
      latin: attr(rf, "ascii"),
      eastAsia: attr(rf, "eastAsia"),
      sizePt: val(child(r, "sz")) ? Number(val(child(r, "sz"))) / 2 : null,
      bold: child(r, "b") ? val(child(r, "b")) !== "0" : null,
      italic: child(r, "i") ? val(child(r, "i")) !== "0" : null,
    },
    paragraph: {
      alignment: val(child(p, "jc")),
      beforePt: attr(spacing, "before")
        ? Number(attr(spacing, "before")) / 20
        : null,
      afterPt: attr(spacing, "after")
        ? Number(attr(spacing, "after")) / 20
        : null,
      line: attr(spacing, "line"),
      lineRule: attr(spacing, "lineRule"),
      indent: obj(indent),
    },
    raw: { pPr: obj(p), rPr: obj(r) },
  };
}
function merge(a, b) {
  const o = structuredClone(a || {});
  for (const [k, v] of Object.entries(b || {}))
    if (v !== null && v !== undefined)
      o[k] = typeof v === "object" && !Array.isArray(v) ? merge(o[k], v) : v;
  return o;
}
export async function importDocx(buffer, name = "导入文档") {
  const zip = await JSZip.loadAsync(buffer);
  const sizes = Object.values(zip.files).reduce(
    (n, f) => n + (f._data?.uncompressedSize || 0),
    0,
  );
  if (sizes > 150 * 1024 * 1024) throw Error("DOCX 解压内容超过 150 MB 限制");
  async function read(path) {
    const file = zip.file(path);
    return file
      ? new DOMParser().parseFromString(await file.async("string"), "text/xml")
      : null;
  }
  const doc = await read("word/document.xml");
  if (!doc) throw Error("无效 DOCX：缺少 word/document.xml");
  const styleDoc = await read("word/styles.xml"),
    numDoc = await read("word/numbering.xml"),
    relDoc = await read("word/_rels/document.xml.rels");
  const rels = Object.fromEntries(
    all(relDoc, "Relationship").map((r) => [
      r.getAttribute("Id"),
      {
        target: r.getAttribute("Target"),
        external: r.getAttribute("TargetMode") === "External",
      },
    ]),
  );
  const definitions = {};
  for (const s of all(styleDoc, "style")) {
    const id = attr(s, "styleId");
    definitions[id] = {
      id,
      name: val(child(s, "name")),
      type: attr(s, "type"),
      basedOn: val(child(s, "basedOn")),
      outlineLevel: val(child(child(s, "pPr"), "outlineLvl")),
      properties: props(child(s, "pPr"), child(s, "rPr")),
      table: obj(child(s, "tblPr")),
      xml: xml.serializeToString(s),
    };
  }
  const defaults = props(
    child(
      child(child(styleDoc?.documentElement, "docDefaults"), "pPrDefault"),
      "pPr",
    ),
    child(
      child(child(styleDoc?.documentElement, "docDefaults"), "rPrDefault"),
      "rPr",
    ),
  );
  function effective(id, seen = new Set()) {
    if (!id || seen.has(id)) return defaults;
    seen.add(id);
    const s = definitions[id];
    return s ? merge(effective(s.basedOn, seen), s.properties) : defaults;
  }
  function level(id, seen = new Set()) {
    if (!id || seen.has(id)) return null;
    seen.add(id);
    const s = definitions[id];
    if (!s) return null;
    if (s.outlineLevel !== null)
      return Number(s.outlineLevel) < 9 ? Number(s.outlineLevel) + 1 : null;
    const m = (s.name || id).match(/^(?:heading\s*|标题\s*)([1-9])$/i);
    return m ? Number(m[1]) : level(s.basedOn, seen);
  }
  const nums = {},
    abstracts = {};
  for (const a of all(numDoc, "abstractNum"))
    abstracts[attr(a, "abstractNumId")] = Object.fromEntries(
      children(a, "lvl").map((l) => [
        attr(l, "ilvl"),
        {
          format: val(child(l, "numFmt")),
          text: val(child(l, "lvlText")),
          start: Number(val(child(l, "start")) || 1),
        },
      ]),
    );
  for (const n of all(numDoc, "num")) {
    const id = attr(n, "numId");
    nums[id] = structuredClone(abstracts[val(child(n, "abstractNumId"))] || {});
    for (const o of children(n, "lvlOverride")) {
      const il = attr(o, "ilvl");
      nums[id][il] ??= { format: "decimal", text: "%1.", start: 1 };
      if (child(o, "startOverride"))
        nums[id][il].start = Number(val(child(o, "startOverride")));
    }
  }
  const defaultStyle = all(styleDoc, "style").find(
    (s) => attr(s, "type") === "paragraph" && attr(s, "default") === "1",
  );
  const defaultStyleId = attr(defaultStyle, "styleId") || "Normal";
  const counters = {},
    warnings = [],
    assets = {},
    imageMap = {};
  const warn = (s) => {
    if (!warnings.includes(s)) warnings.push(s);
  };
  for (const [id, rel] of Object.entries(rels)) {
    if (rel.external) continue;
    const target = rel.target.replace(/^\//, "");
    const path = target.startsWith("word/") ? target : "word/" + target;
    const f = zip.file(path);
    if (
      f &&
      /\.(png|jpg|jpeg|gif|webp|bmp|tif|tiff|svg|emf|wmf)$/i.test(path)
    ) {
      const ext = path.split(".").pop().toLowerCase(),
        dest = `assets/${uid()}.${ext}`;
      assets[dest] = await f.async("nodebuffer");
      imageMap[id] = dest;
      if (!["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext))
        warn(`图片格式 ${ext} 可能无法显示，已保留原始资源。`);
    }
  }
  function numbering(p, style) {
    let n = child(child(p, "pPr"), "numPr");
    if (!n && style) {
      const d = definitions[style];
      if (d) {
        const sn = new DOMParser().parseFromString(d.xml, "text/xml");
        n = all(sn, "numPr")[0];
      }
    }
    if (!n) return null;
    const id = val(child(n, "numId")),
      il = Number(val(child(n, "ilvl")) || 0),
      def = nums[id]?.[il];
    if (!def || id === "0") {
      if (id !== "0") warn("部分编号定义无法解析，原始 DOCX 与 XML 已保留。");
      return null;
    }
    counters[id] ??= {};
    const c = counters[id];
    c[il] = c[il] === undefined ? def.start : c[il] + 1;
    for (const k of Object.keys(c)) if (Number(k) > il) delete c[k];
    function formatted(i) {
      const v = c[i] ?? nums[id]?.[i]?.start ?? 1,
        fmt = nums[id]?.[i]?.format;
      if (fmt === "lowerLetter" || fmt === "upperLetter") {
        if (v > 26) warn("多字母编号需要对照原始 Word 核验。");
        return String.fromCharCode((fmt === "lowerLetter" ? 96 : 64) + v);
      }
      if (fmt && !["decimal", "bullet"].includes(fmt))
        warn(`编号格式 ${fmt} 暂按十进制显示，请对照原始 Word。`);
      return String(v);
    }
    return {
      id,
      level: il,
      format: def.format,
      value: c[il],
      label: (def.text || "%1.").replace(/%(\d)/g, (_, i) =>
        formatted(Number(i) - 1),
      ),
    };
  }
  function runContent(p, style) {
    const out = [];
    function walk(n, link) {
      for (const c of children(n)) {
        if (c.localName === "hyperlink") {
          const r = rels[c.getAttribute("r:id")];
          walk(c, r?.external ? r.target : null);
        } else if (c.localName === "r") {
          const r = child(c, "rPr");
          const rs = val(child(r, "rStyle"));
          const ep = merge(
            rs ? merge(effective(style), effective(rs)) : effective(style),
            props(null, r),
          );
          const marks = [];
          if (ep.font.bold) marks.push({ type: "bold" });
          if (ep.font.italic) marks.push({ type: "italic" });
          if (child(r, "u") && val(child(r, "u")) !== "none")
            marks.push({ type: "underline" });
          if (link && /^https?:\/\//.test(link))
            marks.push({ type: "link", attrs: { href: link } });
          for (const t of children(c)) {
            if (t.localName === "t" || t.localName === "delText") {
              if (t.textContent)
                out.push({
                  type: "text",
                  text: t.textContent,
                  ...(marks.length ? { marks } : {}),
                });
            } else if (t.localName === "tab")
              out.push({ type: "text", text: "\t" });
            else if (t.localName === "br") out.push({ type: "hardBreak" });
            else if (["drawing", "pict"].includes(t.localName)) {
              const ids = all(t, "blip")
                .map((b) => b.getAttribute("r:embed"))
                .concat(all(t, "imagedata").map((b) => b.getAttribute("r:id")));
              if (!ids.length)
                warn("存在不含可提取图片的绘图对象，原始 Word 已保留。");
              for (const id of ids) {
                if (imageMap[id]) {
                  const extent = all(t, "extent")[0];
                  out.push({
                    type: "image",
                    attrs: {
                      src: imageMap[id],
                      alt:
                        all(t, "docPr")[0]?.getAttribute("descr") || "导入图片",
                      width: extent
                        ? Math.round(Number(extent.getAttribute("cx")) / 9525)
                        : null,
                    },
                  });
                } else warn("有无法解析的绘图对象，原始 Word 已保留。");
              }
            }
          }
        } else if (["ins", "del", "sdt", "sdtContent"].includes(c.localName)) {
          warn("存在修订或内容控件；当前视图包含可提取文字，请核对原始 Word。");
          walk(c, link);
        }
      }
    }
    walk(p);
    return out;
  }
  const overrides = {};
  function paragraph(p, allowHeading = true) {
    const pp = child(p, "pPr"),
      sid = val(child(pp, "pStyle")) || defaultStyleId,
      lev =
        level(sid) ??
        (child(pp, "outlineLvl") && Number(val(child(pp, "outlineLvl"))) < 9
          ? Number(val(child(pp, "outlineLvl"))) + 1
          : null),
      num = numbering(p, sid),
      inline = runContent(p, sid);
    const result = [];
    let buf = [];
    const flush = () => {
      if (buf.length || !result.length) {
        const n = {
          type: allowHeading && lev ? "heading" : "paragraph",
          attrs: allowHeading && lev ? { level: Math.min(6, lev) } : {},
          content: buf,
        };
        assignIds(n);
        result.push(n);
        buf = [];
      }
    };
    if (num && lev && num.format !== "bullet") {
      const existing = inline.map((n) => n.text || "").join("");
      if (!existing.startsWith(num.label))
        buf.push({ type: "text", text: num.label + " " });
    }
    for (const n of inline) {
      if (n.type === "image") {
        if (buf.length) flush();
        result.push(assignIds(n));
      } else buf.push(n);
    }
    if (buf.length || !result.length) flush();
    let nodes = result;
    if (num && !lev) {
      nodes = [
        assignIds({
          type: num.format === "bullet" ? "bulletList" : "orderedList",
          attrs: num.format === "bullet" ? {} : { start: num.value },
          content: [{ type: "listItem", content: result }],
        }),
      ];
      if (num.level > 0)
        warn(
          "多级列表保留原始级别与编号元数据；当前视图逐段显示，请按来源编号生成 Word。",
        );
    }
    for (const n of nodes) {
      overrides[n.attrs.id] = {
        styleId: sid,
        effective: effective(sid),
        local: props(pp, null),
        runs: all(p, "rPr").map(obj),
        numbering: num,
        xml: xml.serializeToString(p),
      };
    }
    return { nodes, level: allowHeading ? lev : null };
  }
  function table(t) {
    const rows = [],
      active = new Map();
    for (const tr of children(t, "tr")) {
      const cells = [];
      let col = Number(val(child(child(tr, "trPr"), "gridBefore")) || 0);
      if (col) warn("表格包含省略网格单元格，请参照原始 Word 核验。");
      const next = new Map();
      for (const tc of children(tr, "tc")) {
        const pr = child(tc, "tcPr"),
          span = Number(val(child(pr, "gridSpan")) || 1),
          vm = child(pr, "vMerge"),
          continuation = vm && val(vm) !== "restart";
        if (continuation) {
          const above = active.get(col);
          if (above && above.attrs.colspan === span) {
            above.attrs.rowspan++;
            for (let j = 0; j < span; j++) next.set(col + j, above);
          } else warn("不规则纵向合并单元格，已保留原始表格 XML。");
        } else {
          const content = [];
          for (const c of children(tc)) {
            if (c.localName === "p") content.push(...paragraph(c, false).nodes);
            if (c.localName === "tbl") {
              warn("存在嵌套表格，保留结构，请核验导出。");
              content.push(table(c));
            }
          }
          const cell = assignIds({
            type: "tableCell",
            attrs: { colspan: span, rowspan: 1, colwidth: null },
            content: content.length ? content : [{ type: "paragraph" }],
          });
          cells.push(cell);
          if (vm) for (let j = 0; j < span; j++) next.set(col + j, cell);
        }
        col += span;
      }
      rows.push(assignIds({ type: "tableRow", content: cells }));
      active.clear();
      for (const [k, v] of next) active.set(k, v);
    }
    const n = assignIds({ type: "table", content: rows });
    overrides[n.attrs.id] = {
      styleId: val(child(child(t, "tblPr"), "tblStyle")),
      tableProperties: obj(child(t, "tblPr")),
      xml: xml.serializeToString(t),
    };
    return n;
  }
  const sections = [];
  let section = null;
  const stack = [];
  function make(title, l) {
    const s = { id: uid(), title, level: l, parentId: null, blocks: [] };
    while (stack.length && stack.at(-1).level >= l) stack.pop();
    s.parentId = stack.at(-1)?.id || null;
    if (l > 0) stack.push(s);
    sections.push(s);
    section = s;
    return s;
  }
  for (const el of children(child(doc.documentElement, "body"))) {
    if (el.localName === "p") {
      const p = paragraph(el);
      if (p.level) {
        make(p.nodes.map(plain).join(""), p.level);
      }
      if (!section) make("前言", 0);
      section.blocks.push(
        ...p.nodes.map((n) => block(n, { source: overrides[n.attrs.id] })),
      );
    } else if (el.localName === "tbl") {
      if (!section) make("前言", 0);
      const n = table(el);
      section.blocks.push(block(n, { source: overrides[n.attrs.id] }));
    } else if (el.localName !== "sectPr")
      warn(`正文对象 ${el.localName} 未转换；完整原始文件已保留。`);
  }
  for (const tag of [
    "footnoteReference",
    "endnoteReference",
    "oMath",
    "oMathPara",
    "fldChar",
    "altChunk",
    "commentRangeStart",
    "txbxContent",
    "sym",
    "object",
    "fldSimple",
    "sectPr",
  ]) {
    if (all(doc, tag).length && (tag !== "sectPr" || all(doc, tag).length > 1))
      warn(`检测到 ${tag}，未完全转换，需对照原始 DOCX。`);
  }
  for (const part of [
    "word/header1.xml",
    "word/footer1.xml",
    "word/footnotes.xml",
    "word/endnotes.xml",
  ])
    if (zip.file(part)) warn(`${part} 已随原始 DOCX 保存，未并入可编辑正文。`);
  const compact = (s) => ({ font: s.font, paragraph: s.paragraph });
  const used = new Set(
    Object.values(overrides)
      .map((x) => x.styleId)
      .filter(Boolean),
  );
  const semantic = {
    body: compact(effective("Normal")),
    headings: {},
    captions: {},
    tables: {},
  };
  for (const [id, s] of Object.entries(definitions)) {
    if (!used.has(id)) continue;
    const l = level(id);
    if (l) semantic.headings[l] = { styleId: id, ...compact(effective(id)) };
    if (/caption|题注|图题|表题/i.test(s.name || ""))
      semantic.captions[id] = compact(effective(id));
    if (s.type === "table")
      semantic.tables[id] = { properties: s.table, ...compact(effective(id)) };
  }
  const page = all(doc, "sectPr").map((s) => ({
    size: obj(child(s, "pgSz")),
    margins: obj(child(s, "pgMar")),
    xml: xml.serializeToString(s),
  }));
  return {
    id: uid(),
    formatVersion: 1,
    title: name.replace(/\.docx$/i, ""),
    revision: 1,
    sections: sections.length
      ? sections
      : [{ id: uid(), title: "正文", level: 1, parentId: null, blocks: [] }],
    styles: {
      formatVersion: 1,
      units: { font: "pt", spacing: "pt", page: "twips (1/1440 inch)" },
      defaults,
      semantic,
      definitions,
      localOverrides: overrides,
      pages: page,
    },
    warnings,
    assets,
    original: buffer,
  };
}
