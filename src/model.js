import { uid } from "./content.js";

export class Fault extends Error {
  constructor(message, code = 400) {
    super(message);
    this.code = code;
  }
}

const containers = new Set([
  "doc",
  "paragraph",
  "heading",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
  "bulletList",
  "orderedList",
  "listItem",
  "blockquote",
  "codeBlock",
]);
const leaves = new Set(["text", "hardBreak", "horizontalRule", "image"]);
const marks = new Set([
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
  "superscript",
  "subscript",
  "link",
]);
export const safeLink = (value) =>
  /^(https?:\/\/|mailto:|#)/i.test(value || "");

/** The persistence boundary: copy semantic content only, never Word presentation/XML. */
export function semanticNode(
  input,
  { fresh = false, root = true, depth = 0 } = {},
) {
  if (!input || typeof input !== "object" || depth > 100)
    throw new Fault("无效或嵌套过深的内容");
  const type = input.type;
  if (!containers.has(type) && !leaves.has(type))
    throw new Fault("不支持的内容类型：" + type);
  if (
    root &&
    [
      "doc",
      "text",
      "tableRow",
      "tableCell",
      "tableHeader",
      "hardBreak",
      "listItem",
    ].includes(type)
  )
    throw new Fault("无效的顶层块类型：" + type);
  if (leaves.has(type) && input.content?.length)
    throw new Fault("叶节点不允许包含子内容");
  if (type !== "text" && input.text)
    throw new Fault("只有 text 节点可以包含 text 字段");
  const n = { type },
    a = input.attrs || {};
  if (type === "text") {
    if (typeof input.text !== "string") throw new Fault("文本必须是字符串");
    n.text = input.text;
    if (input.marks?.length) {
      n.marks = input.marks.map((m) => {
        if (!marks.has(m.type)) throw new Fault("不支持的行内语义：" + m.type);
        if (m.type === "link") {
          if (!safeLink(m.attrs?.href))
            throw new Fault("链接仅支持 http/https/mailto/文档锚点");
          return { type: "link", attrs: { href: m.attrs.href } };
        }
        return { type: m.type };
      });
    }
    return n;
  }
  const attrs = {};
  if (!root) attrs.id = fresh || !a.id ? uid() : String(a.id);
  if (type === "image") {
    if (!/^assets\/[\w.-]+$/.test(a.src || ""))
      throw new Fault("图片必须引用项目 assets/ 资源");
    attrs.src = a.src;
    attrs.alt = String(a.alt || "");
    for (const k of ["width", "height"])
      if (Number(a[k]) > 0) attrs[k] = Number(a[k]);
  }
  if (["tableCell", "tableHeader"].includes(type)) {
    for (const k of ["rowspan", "colspan"]) {
      const v = Number(a[k] ?? 1);
      if (!Number.isInteger(v) || v < 1 || v > 10000)
        throw new Fault("表格跨度无效");
      attrs[k] = v;
    }
  }
  if (type === "orderedList") attrs.start = Math.max(1, Number(a.start) || 1);
  if (type === "heading" && !root)
    attrs.level = Math.max(1, Math.min(9, Number(a.level) || 1));
  if (Object.keys(attrs).length) n.attrs = attrs;
  if (containers.has(type)) {
    if (!Array.isArray(input.content || []))
      throw new Fault("content 必须是数组");
    n.content = (input.content || []).map((c) =>
      semanticNode(c, { fresh, root: false, depth: depth + 1 }),
    );
    const blockTypes = [
      "paragraph",
      "heading",
      "codeBlock",
      "image",
      "table",
      "bulletList",
      "orderedList",
      "blockquote",
      "horizontalRule",
    ];
    const allowed =
      type === "table"
        ? ["tableRow"]
        : type === "tableRow"
          ? ["tableCell", "tableHeader"]
          : ["paragraph", "heading", "codeBlock"].includes(type)
            ? ["text", "hardBreak"]
            : ["bulletList", "orderedList"].includes(type)
              ? ["listItem"]
              : blockTypes;
    if (allowed && n.content.some((c) => !allowed.includes(c.type)))
      throw new Fault(type + " 包含无效子节点");
    if (type === "table") validateTable(n);
  }
  return n;
}

export function validateTable(n) {
  // Sparse occupancy avoids scanning every preceding cell on each placement.
  const occupied = new Set();
  const rows = n.content || [];
  if (!rows.length) throw new Fault("表格至少需要一行");
  let width = 0;
  rows.forEach((row, r) => {
    let col = 0;
    for (const cell of row.content || []) {
      while (occupied.has(r + ":" + col)) col++;
      const rs = cell.attrs.rowspan,
        cs = cell.attrs.colspan;
      if (r + rs > rows.length || col + cs > 10000)
        throw new Fault("表格合并超出范围");
      for (let y = r; y < r + rs; y++)
        for (let x = col; x < col + cs; x++) {
          const key = y + ":" + x;
          if (occupied.has(key)) throw new Fault("表格合并重叠");
          occupied.add(key);
        }
      col += cs;
      width = Math.max(width, col);
    }
  });
  return { rows: rows.length, columns: width };
}

export function assetRefs(node, result = new Set()) {
  if (node.type === "image") result.add(node.attrs.src);
  for (const c of node.content || []) assetRefs(c, result);
  return result;
}

export function expect(actual, expected) {
  if (!Number.isInteger(expected) || actual !== expected)
    throw new Fault(
      `版本冲突：期望 ${expected}，当前 ${actual}。请重新读取；原内容未被覆盖。`,
      409,
    );
}
