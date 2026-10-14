import { marked } from "marked";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { randomUUID } from "node:crypto";
export const uid = () => randomUUID();
export const escape = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function assignIds(n, fresh = false) {
  if (n.type !== "text" && n.type !== "doc") {
    n.attrs ??= {};
    if (fresh || !n.attrs.id) n.attrs.id = uid();
  }
  for (const c of n.content || []) assignIds(c, fresh);
  return n;
}
export function plain(n) {
  return n.type === "text"
    ? n.text
    : (n.content || []).map(plain).join(n.type === "tableRow" ? "\t" : "");
}
export function html(n) {
  const a = n.attrs || {};
  const body = (n.content || []).map(html).join("");
  if (n.type === "text") {
    let t = escape(n.text);
    for (const m of n.marks || [])
      if (
        {
          bold: "strong",
          italic: "em",
          strike: "s",
          underline: "u",
          code: "code",
        }[m.type]
      ) {
        const tag = {
          bold: "strong",
          italic: "em",
          strike: "s",
          underline: "u",
          code: "code",
        }[m.type];
        t = `<${tag}>${t}</${tag}>`;
      } else if (m.type === "link" && /^https?:\/\//i.test(m.attrs?.href || ""))
        t = `<a href="${escape(m.attrs.href)}">${t}</a>`;
    return t;
  }
  const tag = {
    doc: "div",
    paragraph: "p",
    heading: `h${Math.min(6, a.level || 1)}`,
    bulletList: "ul",
    orderedList: "ol",
    listItem: "li",
    blockquote: "blockquote",
    codeBlock: "pre",
    table: "table",
    tableRow: "tr",
    tableCell: "td",
    tableHeader: "th",
  }[n.type];
  if (n.type === "image")
    return `<img src="${escape(a.src)}" alt="${escape(a.alt)}"${a.width ? ` width="${Number(a.width)}"` : ""}>`;
  if (n.type === "hardBreak") return "<br>";
  if (n.type === "horizontalRule") return "<hr>";
  return tag
    ? `<${tag}${a.colspan ? ` colspan="${Number(a.colspan)}"` : ""}${a.rowspan ? ` rowspan="${Number(a.rowspan)}"` : ""}${n.type === "orderedList" ? ` start="${a.start || 1}"` : ""}>${body}</${tag}>`
    : body;
}
const td = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
});
td.use(gfm);
td.addRule("complexTable", {
  filter: (n) =>
    n.nodeName === "TABLE" &&
    !!n.querySelector(
      '[colspan]:not([colspan="1"]),[rowspan]:not([rowspan="1"])',
    ),
  replacement: (_, n) => "\n\n" + n.outerHTML + "\n\n",
});
export function markdown(n) {
  return td.turndown(html(n));
}
export function fromMarkdown(md) {
  const { document } = parseHTML(
    `<html><body>${marked.parse(md)}</body></html>`,
  );
  function inline(el, marks = []) {
    if (el.nodeType === 3)
      return el.textContent
        ? [
            {
              type: "text",
              text: el.textContent,
              ...(marks.length ? { marks } : {}),
            },
          ]
        : [];
    let m = [...marks];
    const mark = {
      STRONG: "bold",
      B: "bold",
      EM: "italic",
      I: "italic",
      S: "strike",
      DEL: "strike",
      U: "underline",
      CODE: "code",
    }[el.tagName];
    if (mark) m.push({ type: mark });
    if (
      el.tagName === "A" &&
      /^https?:\/\//.test(el.getAttribute("href") || "")
    )
      m.push({ type: "link", attrs: { href: el.getAttribute("href") } });
    if (el.tagName === "BR") return [{ type: "hardBreak" }];
    return [...el.childNodes].flatMap((c) => inline(c, m));
  }
  function node(el) {
    const tag = el.tagName;
    const type =
      {
        P: "paragraph",
        UL: "bulletList",
        OL: "orderedList",
        LI: "listItem",
        TABLE: "table",
        TR: "tableRow",
        TD: "tableCell",
        TH: "tableHeader",
        BLOCKQUOTE: "blockquote",
        PRE: "codeBlock",
        HR: "horizontalRule",
        IMG: "image",
      }[tag] || (/^H[1-6]$/.test(tag) ? "heading" : null);
    if (!type) return [];
    let n = { type };
    if (type === "image") {
      const src = el.getAttribute("src") || "";
      if (!/^assets\/[a-zA-Z0-9_.-]+$/.test(src))
        throw Error("图片必须使用 assets/ 相对资源路径");
      n.attrs = { src, alt: el.getAttribute("alt") || "" };
    } else if (type === "heading") n.attrs = { level: Number(tag[1]) };
    else if (type === "orderedList")
      n.attrs = { start: Number(el.getAttribute("start") || 1) };
    else if (type === "tableCell" || type === "tableHeader")
      n.attrs = {
        colspan: Number(el.getAttribute("colspan") || 1),
        rowspan: Number(el.getAttribute("rowspan") || 1),
      };
    if (["paragraph", "heading", "codeBlock"].includes(type))
      n.content = inline(el);
    else if (type === "table")
      n.content = [
        ...el.querySelectorAll(
          ":scope > tr,:scope > tbody > tr,:scope > thead > tr",
        ),
      ].flatMap(node);
    else if (!["image", "horizontalRule"].includes(type)) {
      n.content = [...el.children].flatMap(node);
      if (!n.content.length)
        n.content = [{ type: "paragraph", content: inline(el) }];
    }
    return [assignIds(n)];
  }
  return [...document.body.children].flatMap(node);
}
export function block(node, old) {
  assignIds(node);
  return {
    id: node.attrs.id,
    type: node.type,
    markdown: markdown(node),
    node,
    ...(old?.source ? { source: old.source } : {}),
  };
}
export function replaceText(node, oldText, newText) {
  if (!oldText) throw Error("旧文本不能为空");
  const leaves = [];
  function visit(n) {
    if (n.type === "text") leaves.push(n);
    else if (["hardBreak", "image"].includes(n.type)) leaves.push(null);
    else {
      for (const c of n.content || []) visit(c);
      if (
        [
          "paragraph",
          "heading",
          "listItem",
          "tableCell",
          "tableHeader",
        ].includes(n.type)
      )
        leaves.push(null);
    }
  }
  visit(node);
  const text = leaves.map((n) => (n ? n.text : "\n")).join("");
  const start = text.indexOf(oldText);
  if (start < 0 || text.indexOf(oldText, start + 1) >= 0)
    throw Error("旧文本必须恰好匹配一次");
  let offset = 0,
    inserted = false;
  for (const leaf of leaves) {
    const len = leaf ? leaf.text.length : 1;
    if (leaf && offset < start + oldText.length && offset + len > start) {
      const l = Math.max(0, start - offset),
        r = Math.min(len, start + oldText.length - offset);
      leaf.text =
        leaf.text.slice(0, l) + (inserted ? "" : newText) + leaf.text.slice(r);
      inserted = true;
    }
    offset += len;
  }
  function clean(n) {
    if (n.content)
      n.content = n.content
        .filter((c) => c.type !== "text" || c.text)
        .map(clean);
    return n;
  }
  return clean(node);
}
