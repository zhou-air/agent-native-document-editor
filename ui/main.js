import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import Image from "@tiptap/extension-image";
import UniqueID from "@tiptap/extension-unique-id";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import "./style.css";
const $ = (s) => document.querySelector(s),
  token =
    new URLSearchParams(location.search).get("token") ||
    sessionStorage.getItem("token");
sessionStorage.setItem("token", token);
history.replaceState(null, "", "/");
let project = null,
  sectionId = null,
  editor = null,
  base = null,
  dirty = false,
  saving = null,
  timer = null,
  conflicted = false,
  selectedId = null,
  mode = "new",
  polling = false,
  styleDirty = false,
  styleBaseRevision = null,
  styleScope = "rules";
const moveUndo = [],
  moveRedo = [];
const collapsed = new Set();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = (x) => structuredClone(x);
const nodeText = (n) =>
  n.type === "text" ? n.text : (n.content || []).map(nodeText).join("");
function notice(message) {
  $("#notice").textContent = message;
  $("#notice").hidden = !message;
}
async function api(route, data) {
  const r = await fetch("/api/" + route, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!r.ok) {
    const result = await r.json();
    const e = Error(result.error);
    e.code = r.status;
    throw e;
  }
  return r.json();
}
const tool = (name, args) => api("tool", { name, args });
function draftKey() {
  return "draft:" + project.id + ":" + sectionId;
}
function keepDraft() {
  if (editor && project)
    try {
      localStorage.setItem(
        draftKey(),
        JSON.stringify({
          projectId: project.id,
          sectionId,
          base,
          nodes: editor.getJSON().content || [],
          savedAt: new Date().toISOString(),
        }),
      );
    } catch {
      notice("浏览器草稿存储已满，请立即保存或下载草稿。");
    }
}
function current() {
  return project?.sections.find((s) => s.id === sectionId);
}
function nodes() {
  return editor?.getJSON().content || [];
}
function status() {
  if (!project) return;
  $("#sync").textContent = conflicted
    ? "存在冲突 · 输入已保留"
    : dirty
      ? "编辑中 · 自动保存待写入"
      : "✓ 已保存到本地";
  $("#revision").textContent = `项目版本 ${project.revision} · MCP 已连接`;
  $("#stats").textContent =
    `${project.sections.length} 个章节 · 本节 ${nodes().length} 个块 · ${nodes().map(nodeText).join("").length} 字符`;
}
// Table split commands can clone cell attributes; repair remaining duplicate IDs
// in the same ProseMirror history transaction, without deriving identity from text.
const IdentityRepair = Extension.create({
  name: "identityRepair",
  priority: 1,
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("identityRepair"),
        appendTransaction(transactions, oldState, newState) {
          if (!transactions.some((t) => t.docChanged)) return;
          const seen = new Set(),
            tr = newState.tr;
          newState.doc.descendants((node, pos) => {
            if (node.type.name === "text" || !Object.hasOwn(node.attrs, "id"))
              return;
            let id = node.attrs.id;
            if (!id || seen.has(id)) {
              id = crypto.randomUUID();
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, id });
            }
            seen.add(id);
          });
          if (tr.steps.length) {
            tr.setStoredMarks(newState.storedMarks);
            return tr;
          }
        },
      }),
    ];
  },
});
const LocalImage = Image.extend({
  renderHTML({ HTMLAttributes }) {
    return [
      "img",
      { ...HTMLAttributes, src: "/" + HTMLAttributes.src + "?token=" + token },
    ];
  },
});
function mount(s) {
  editor?.destroy();
  $("#editor").innerHTML = "";
  editor = new Editor({
    element: $("#editor"),
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] } }),
      TableKit.configure({ table: { resizable: false } }),
      LocalImage,
      UniqueID.configure({
        types: "all",
        generateID: () => crypto.randomUUID(),
      }),
      IdentityRepair,
    ],
    content: {
      type: "doc",
      content: s.blocks.length
        ? s.blocks.map((b) => b.node)
        : [{ type: "paragraph", attrs: { id: crypto.randomUUID() } }],
    },
    onUpdate: () => {
      dirty = true;
      keepDraft();
      clearTimeout(timer);
      timer = setTimeout(() => save().catch(handle), 500);
      status();
      renderBlocks();
    },
    onSelectionUpdate: () => inspect(),
    editorProps: {
      handlePaste(view, event) {
        const files = Array.from(event.clipboardData?.files || []);
        if (files.length) {
          event.preventDefault();
          insertImage(files[0]).catch(handle);
          return true;
        }
        return false;
      },
      handleDrop(view, event) {
        if (event.dataTransfer?.files.length) {
          event.preventDefault();
          insertImage(event.dataTransfer.files[0]).catch(handle);
          return true;
        }
        return false;
      },
    },
  });
  base = clone(s);
  dirty = false;
  selectedId = s.blocks[0]?.id;
  inspect();
  renderBlocks();
  const recovered = localStorage.getItem(draftKey());
  if (recovered) {
    try {
      const d = JSON.parse(recovered);
      if (
        !same(
          d.nodes,
          s.blocks.map((b) => b.node),
        )
      ) {
        editor.commands.setContent(
          { type: "doc", content: d.nodes },
          { emitUpdate: false },
        );
        base = d.base;
        dirty = true;
        conflicted = true;
        $("#conflict").hidden = false;
        notice(
          "发现未提交草稿，已恢复编辑区。请下载草稿或读取服务端版本后核对。",
        );
      }
    } catch {}
  }
  status();
}
function renderTree() {
  const root = $("#tree");
  root.innerHTML = "";
  const query = $("#search").value.toLowerCase();
  for (const s of project.sections) {
    let parent = s.parentId,
      hidden = false;
    while (parent) {
      if (collapsed.has(parent)) hidden = true;
      parent = project.sections.find((x) => x.id === parent)?.parentId;
    }
    if (query ? !s.title.toLowerCase().includes(query) : hidden) continue;
    const row = document.createElement("div");
    row.className = "tree-row" + (s.id === sectionId ? " selected" : "");
    row.style.paddingLeft = Math.min(5, Math.max(0, s.level - 1)) * 12 + "px";
    const toggle = document.createElement("button");
    const has = project.sections.some((x) => x.parentId === s.id);
    toggle.textContent = has ? (collapsed.has(s.id) ? "▸" : "▾") : "·";
    toggle.onclick = () => {
      collapsed.has(s.id) ? collapsed.delete(s.id) : collapsed.add(s.id);
      renderTree();
    };
    const b = document.createElement("button");
    b.textContent = s.title;
    b.className = "tree-title";
    b.onclick = () => switchSection(s.id).catch(handle);
    row.append(toggle, b);
    root.append(row);
  }
  const targetValue = $("#move-target").value;
  $("#move-target").replaceChildren(
    ...project.sections.map((s) => {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = s.title;
      return o;
    }),
  );
  if (project.sections.some((s) => s.id === targetValue))
    $("#move-target").value = targetValue;
}
function renderProject() {
  if (!project) return;
  $("#empty").hidden = true;
  $("#paper").hidden = false;
  $("#project-title").textContent = project.title;
  $("#project-path").textContent = project.path;
  $("#crumb").textContent = project.title + " / " + (current()?.title || "");
  $("#section-meta").textContent =
    "SECTION " + String((current()?.order || 0) + 1).padStart(2, "0");
  $("#warnings").textContent = project.warnings?.length
    ? project.warnings.join("\n\n")
    : "未检测到需提示的转换问题";
  if (!styleDirty) showStyles();
  renderTree();
  status();
}
async function switchSection(id) {
  if (id === sectionId) return;
  await save();
  if (conflicted) throw Error("请先处理当前章节冲突");
  sectionId = id;
  mount(current());
  renderProject();
}
function applyNodes(incoming) {
  if (same(nodes(), incoming)) return;
  const before = nodes();
  const ids = before.map((n) => n.attrs?.id),
    newIds = incoming.map((n) => n.attrs?.id);
  if (same(ids, newIds)) {
    let tr = editor.state.tr;
    let pos = editor.state.doc.content.size;
    for (let i = before.length - 1; i >= 0; i--) {
      const old = editor.state.doc.child(i);
      pos -= old.nodeSize;
      if (!same(before[i], incoming[i]))
        tr = tr.replaceWith(
          pos,
          pos + old.nodeSize,
          editor.schema.nodeFromJSON(incoming[i]),
        );
    }
    tr.setMeta("addToHistory", false).setMeta("preventUpdate", true);
    editor.view.dispatch(tr);
  } else {
    const selection = editor.state.selection.from;
    editor.commands.setContent(
      {
        type: "doc",
        content: incoming.length
          ? incoming
          : [{ type: "paragraph", attrs: { id: crypto.randomUUID() } }],
      },
      { emitUpdate: false },
    );
    editor.commands.setTextSelection(
      Math.min(selection, editor.state.doc.content.size),
    );
  }
  renderBlocks();
}
async function save() {
  clearTimeout(timer);
  if (saving) {
    await saving;
    if (dirty && !conflicted) return save();
    return;
  }
  if (!dirty || !editor || conflicted) return;
  const snapshot = clone(nodes()),
    capturedSection = sectionId,
    capturedBase = clone(base);
  const changed = snapshot.filter(
    (n) =>
      !same(n, capturedBase.blocks.find((b) => b.id === n.attrs?.id)?.node),
  );
  const versions = Object.fromEntries(
    capturedBase.blocks.map((b) => [b.id, b.revision]),
  );
  saving = (async () => {
    try {
      const result = await tool("save_section", {
        section_id: capturedSection,
        nodes: snapshot,
        changed,
        versions,
        base_ids: capturedBase.blocks.map((b) => b.id),
        section_revision: capturedBase.revision,
      });
      const latest = clone(nodes());
      project = result;
      const remote = current();
      base = clone(remote);
      if (same(latest, snapshot)) {
        applyNodes(remote.blocks.map((b) => b.node));
        dirty = false;
        localStorage.removeItem(draftKey());
      } else {
        const pending = latest.filter(
          (n) =>
            !same(
              n,
              snapshot.find((o) => o.attrs?.id === n.attrs?.id),
            ),
        );
        const structural = !same(
          latest.map((n) => n.attrs?.id),
          snapshot.map((n) => n.attrs?.id),
        );
        const combined = structural
          ? latest
          : remote.blocks.map(
              (b) => pending.find((n) => n.attrs?.id === b.id) || b.node,
            );
        applyNodes(combined);
        dirty = true;
        keepDraft();
      }
      renderProject();
    } catch (e) {
      if (e.code === 409) {
        conflicted = true;
        $("#conflict").hidden = false;
        keepDraft();
      }
      throw e;
    } finally {
      saving = null;
      status();
    }
  })();
  await saving;
  if (dirty && !conflicted) return save();
}
function handle(e) {
  notice(e.message || String(e));
  status();
}
function inspect() {
  if (!editor) return;
  const sel = editor.state.selection;
  let node = sel instanceof NodeSelection ? sel.node : null;
  if (!node || !nodes().some((n) => n.attrs?.id === node.attrs?.id)) {
    let pos = 0;
    editor.state.doc.forEach((n) => {
      if (sel.from >= pos && sel.from <= pos + n.nodeSize) node = n;
      pos += n.nodeSize;
    });
  }
  selectedId = node?.attrs?.id;
  $("#block-id").textContent = selectedId || "—";
  $("#block-type").textContent = node?.type.name || "未选择";
  const b = current()?.blocks.find((b) => b.id === selectedId);
  $("#block-meta").textContent = b
    ? `块版本 ${b.revision} · 顺序 ${b.order + 1}`
    : "新块 · 待自动保存";
}
function renderBlocks() {
  if (!editor) return;
  const list = $("#block-list");
  list.innerHTML = "";
  let pos = 0;
  editor.state.doc.forEach((n) => {
    const b = document.createElement("button");
    b.textContent =
      n.type.name === "image"
        ? "▧ 图片"
        : n.type.name === "table"
          ? "▦ 表格"
          : nodeText(n.toJSON()).slice(0, 22) || "空段落";
    const from = pos;
    b.onclick = () => {
      editor.commands.setNodeSelection(from);
      editor.commands.focus();
      inspect();
    };
    list.append(b);
    pos += n.nodeSize;
  });
  inspect();
}
function fresh(n) {
  const x = clone(n);
  function visit(n) {
    if (n.type !== "text" && n.type !== "doc") {
      n.attrs ??= {};
      n.attrs.id = crypto.randomUUID();
    }
    for (const c of n.content || []) visit(c);
  }
  visit(x);
  return x;
}
function replaceAll(ns) {
  const tr = editor.state.tr.replaceWith(
    0,
    editor.state.doc.content.size,
    ns.map((n) => editor.schema.nodeFromJSON(n)),
  );
  editor.view.dispatch(tr);
}
function operate(op) {
  if (!editor) return;
  const ns = clone(nodes()),
    i = ns.findIndex((n) => n.attrs?.id === selectedId);
  if (i < 0) return;
  if (op === "copy") ns.splice(i + 1, 0, fresh(ns[i]));
  if (op === "delete") ns.splice(i, 1);
  if (op === "insert")
    ns.splice(i + 1, 0, {
      type: "paragraph",
      attrs: { id: crypto.randomUUID() },
    });
  if (op === "up" && i > 0) [ns[i - 1], ns[i]] = [ns[i], ns[i - 1]];
  if (op === "down" && i < ns.length - 1)
    [ns[i], ns[i + 1]] = [ns[i + 1], ns[i]];
  if (!ns.length)
    ns.push({ type: "paragraph", attrs: { id: crypto.randomUUID() } });
  replaceAll(ns);
}
for (const [name, op] of [
  ["copy", "copy"],
  ["delete", "delete"],
  ["insert", "insert"],
  ["up", "up"],
  ["down", "down"],
])
  $("#" + name + "-block").onclick = () => operate(op);
$("#move-block").onclick = async () => {
  try {
    await save();
    if (conflicted) return;
    const b = current().blocks.find((b) => b.id === selectedId),
      dest = project.sections.find((s) => s.id === $("#move-target").value);
    if (!b) return;
    const old = clone(
      project.sections.filter((s) => s.id === sectionId || s.id === dest.id),
    );
    project = await tool("move_block", {
      block_id: b.id,
      expected_revision: b.revision,
      section_id: dest.id,
      target_revision: dest.revision,
    });
    moveUndo.push({ sections: old, expected: project.revision });
    moveRedo.length = 0;
    mount(current());
    renderProject();
  } catch (e) {
    handle(e);
  }
};
async function undoMove(redo = false) {
  const stack = redo ? moveRedo : moveUndo,
    other = redo ? moveUndo : moveRedo;
  const item = stack.at(-1);
  if (!item) return;
  await save();
  const old = clone(
    project.sections.filter((s) => item.sections.some((x) => x.id === s.id)),
  );
  project = await tool("restore_sections", {
    sections: item.sections,
    expected_revision: item.expected,
  });
  stack.pop();
  other.push({ sections: old, expected: project.revision });
  mount(current());
  renderProject();
}
for (const b of document.querySelectorAll("[data-cmd]")) {
  b.onmousedown = (e) => e.preventDefault();
  b.onclick = () => {
    if (!editor) return;
    const cmd = b.dataset.cmd;
    if (cmd === "undo" && !editor.can().undo() && moveUndo.length) {
      undoMove().catch(handle);
      return;
    }
    if (cmd === "redo" && !editor.can().redo() && moveRedo.length) {
      undoMove(true).catch(handle);
      return;
    }
    const c = editor.chain().focus();
    const mapped = {
      bold: "toggleBold",
      italic: "toggleItalic",
      paragraph: "setParagraph",
      bulletList: "toggleBulletList",
      orderedList: "toggleOrderedList",
    };
    let ok;
    if (cmd === "heading") ok = c.toggleHeading({ level: 2 }).run();
    else if (cmd === "table")
      ok = c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    else ok = c[mapped[cmd] || cmd]().run();
    if (!ok)
      notice(
        "当前选择无法执行该操作。合并单元格：按住 Shift 选择相邻单元格后点击“合并”。",
      );
  };
}
const base64 = async (f) => {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 32768)
    s += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(s);
};
async function insertImage(f) {
  if (!editor || !f) return;
  const asset = await api("asset", { name: f.name, data: await base64(f) });
  editor.chain().focus().setImage({ src: asset.src, alt: f.name }).run();
}
$("#image").onclick = () => $("#image-input").click();
$("#image-input").onchange = (e) =>
  insertImage(e.target.files[0]).catch(handle);
$("#search").oninput = () => project && renderTree();
function projectDialog(m) {
  mode = m;
  $("#dialog-title").textContent = {
    new: "新建项目",
    open: "打开本地项目",
    import: "导入 Word 为新项目",
  }[m];
  $("#docx-label").hidden = m !== "import";
  $("#name-input").parentElement.hidden = m === "open";
  $("#dialog-error").textContent = "";
  $("#project-dialog").showModal();
}
for (const m of ["new", "open", "import"])
  $("#" + m).onclick = async () => {
    try {
      await save();
      if (!conflicted) projectDialog(m);
    } catch (e) {
      handle(e);
    }
  };
$("#choose-dir").onclick = async () => {
  if (window.desktop) {
    const p = await window.desktop.chooseDirectory();
    if (p) $("#path-input").value = p;
  } else $("#path-input").focus();
};
$("#confirm-project").onclick = async () => {
  const button = $("#confirm-project");
  button.disabled = true;
  try {
    const path = $("#path-input").value.trim();
    if (!path) throw Error("请选择项目文件夹");
    let data = { path, title: $("#name-input").value };
    if (mode === "import") {
      const f = $("#docx-input").files[0];
      if (!f) throw Error("请选择 DOCX 文件");
      data.docx = await base64(f);
      data.filename = f.name;
    }
    project = await api(mode === "open" ? "open" : "create", data);
    sectionId = project.sections[0].id;
    moveUndo.length = 0;
    moveRedo.length = 0;
    conflicted = false;
    $("#conflict").hidden = true;
    styleDirty = false;
    mount(current());
    renderProject();
    $("#project-dialog").close();
    notice(
      mode === "import"
        ? `导入完成：${project.sections.length} 个章节，${project.warnings.length} 条需核验提示。`
        : "",
    );
  } catch (e) {
    $("#dialog-error").textContent = e.message;
  } finally {
    button.disabled = false;
  }
};
$("#save").onclick = () => save().catch(handle);
function download(data, name, type = "application/json") {
  const url = URL.createObjectURL(new Blob([data], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
$("#draft").onclick = () =>
  download(
    JSON.stringify({ sectionId, base, nodes: nodes() }, null, 2),
    "local-draft.json",
  );
$("#reload").onclick = async () => {
  try {
    localStorage.removeItem(draftKey());
    project = (await api("project")).project;
    conflicted = false;
    dirty = false;
    $("#conflict").hidden = true;
    mount(current());
    renderProject();
    notice("已读取服务端最新版本。");
  } catch (e) {
    handle(e);
  }
};
$("#export").onclick = async () => {
  try {
    await save();
    if (conflicted) return;
    const sectionOnly = confirm(
      "导出范围：点击“确定”导出整个项目；点击“取消”仅导出当前章节。",
    );
    const r = await fetch("/api/export", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sectionOnly ? {} : { section_ids: [sectionId] }),
    });
    if (!r.ok) throw Error((await r.json()).error);
    download(await r.blob(), "document-package.zip", "application/zip");
    notice(
      "已导出自包含内容包：Markdown、结构 JSON、样式、资源和 Word 生成规则。",
    );
  } catch (e) {
    handle(e);
  }
};
$("#add-section").onclick = () => project && $("#section-dialog").showModal();
$("#section-cancel").onclick = () => $("#section-dialog").close();
$("#section-confirm").onclick = async () => {
  try {
    await save();
    const level = Number($("#section-level").value);
    const parent = [...project.sections]
      .reverse()
      .find((s) => s.level < level && s.level > 0);
    project = await tool("add_section", {
      title: $("#section-title").value,
      level,
      parent_id: parent?.id,
      expected_revision: project.revision,
    });
    sectionId = project.sections.at(-1).id;
    mount(current());
    renderProject();
    $("#section-dialog").close();
  } catch (e) {
    handle(e);
  }
};
for (const tab of ["block", "style"])
  $("#tab-" + tab).onclick = () => {
    for (const x of ["block", "style"]) {
      $("#" + x + "-panel").hidden = x !== tab;
      $("#tab-" + x).classList.toggle("active", x === tab);
    }
  };
function styleValue() {
  return $("#style-scope").value === "rules"
    ? { semantic: project.styles.semantic, pages: project.styles.pages }
    : $("#style-scope").value === "all"
      ? project.styles
      : project.styles[$("#style-scope").value];
}
function showStyles() {
  styleScope = $("#style-scope").value;
  $("#styles").value = JSON.stringify(styleValue(), null, 2);
}
$("#style-scope").onchange = () => {
  if (styleDirty) {
    $("#style-scope").value = styleScope;
    notice("切换前请先保存样式修改。");
    return;
  }
  showStyles();
};
$("#styles").oninput = () => {
  if (!styleDirty) styleBaseRevision = project.revision;
  styleDirty = true;
};
$("#save-style").onclick = async () => {
  try {
    await save();
    const value = JSON.parse($("#styles").value),
      scope = $("#style-scope").value;
    const styles =
      scope === "all"
        ? value
        : scope === "rules"
          ? { ...project.styles, ...value }
          : { ...project.styles, [scope]: value };
    project = await tool("styles", {
      styles,
      expected_revision: styleBaseRevision ?? project.revision,
    });
    styleDirty = false;
    renderProject();
    notice("styles.json 已保存。");
  } catch (e) {
    handle(e);
  }
};
$("#preset-out").onclick = () => {
  try {
    download(
      JSON.stringify(
        {
          formatVersion: 1,
          semantic: JSON.parse($("#styles").value).semantic,
          pages: JSON.parse($("#styles").value).pages,
        },
        null,
        2,
      ),
      "style-preset.json",
    );
  } catch (e) {
    handle(e);
  }
};
$("#preset-in").onclick = () => $("#preset-input").click();
$("#preset-input").onchange = async (e) => {
  try {
    const preset = JSON.parse(await e.target.files[0].text());
    const current = JSON.parse($("#styles").value);
    current.semantic = preset.semantic;
    current.pages = preset.pages;
    $("#style-scope").value = "rules";
    $("#styles").value = JSON.stringify(
      { semantic: current.semantic, pages: current.pages },
      null,
      2,
    );
    if (!styleDirty) styleBaseRevision = project.revision;
    styleDirty = true;
    notice("预设已载入，请点击保存 styles.json。");
  } catch (e) {
    handle(e);
  }
};
setInterval(async () => {
  if (polling || saving || conflicted || !project) return;
  polling = true;
  try {
    const r = await api("revision");
    if (r.id !== project.id) {
      if (dirty) {
        conflicted = true;
        $("#conflict").hidden = false;
        keepDraft();
        notice("其他客户端切换了项目，本地草稿已保留。");
      } else {
        project = (await api("project")).project;
        sectionId = project.sections[0].id;
        mount(current());
        renderProject();
      }
    } else if (r.revision !== project.revision) {
      if (dirty) await save();
      else {
        const result = (await api("project")).project;
        const s = result.sections.find((s) => s.id === sectionId);
        project = result;
        if (s) {
          applyNodes(s.blocks.map((b) => b.node));
          base = clone(s);
        }
        renderProject();
        status();
      }
    }
  } catch (e) {
    handle(e);
  } finally {
    polling = false;
  }
}, 700);
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && editor) {
    const redo = e.shiftKey;
    if (
      !(redo ? editor.can().redo() : editor.can().undo()) &&
      (redo ? moveRedo : moveUndo).length
    ) {
      e.preventDefault();
      undoMove(redo).catch(handle);
      return;
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    save().catch(handle);
  }
});
window.addEventListener("beforeunload", (e) => {
  if (dirty || conflicted) {
    keepDraft();
    e.preventDefault();
    e.returnValue = "有未保存内容";
  }
});
window.desktop?.onClose(async () => {
  try {
    await save();
    if (conflicted) {
      notice("请先下载草稿并处理冲突，再关闭程序。");
      return;
    }
    if (styleDirty) {
      notice("样式尚未保存，请先保存样式再关闭。");
      return;
    }
    window.desktop.closeReady();
  } catch (e) {
    handle(e);
  }
});
// Read-only diagnostic access plus the actual editor instance for deterministic acceptance tests.
window.workbench = {
  get editor() {
    return editor;
  },
  get project() {
    return project;
  },
  get sectionId() {
    return sectionId;
  },
  get dirty() {
    return dirty;
  },
  get conflicted() {
    return conflicted;
  },
  save,
  switchSection,
};
try {
  project = (await api("project")).project;
  if (project) {
    sectionId = project.sections[0].id;
    mount(current());
    renderProject();
  }
} catch (e) {
  handle(e);
}
