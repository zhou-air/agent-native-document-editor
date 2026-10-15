using System.Text.Json.Nodes;
using AgentDocument.WinUI.Controls;

int assertions = 0;
var cases = new List<string>();
void Check(bool condition, string message) { assertions++; if (!condition) throw new InvalidOperationException(message); }
void Run(string name, Action test) { test(); cases.Add(name); }
string Id(JsonObject n) => DocumentNodes.Id(n)!;
void GridValid(JsonObject table, int rows, int columns)
{
    var grid = NativeTableModel.Layout(table);
    Check(grid.Rows == rows && grid.Columns == columns, $"grid dimensions {grid.Rows}×{grid.Columns}, expected {rows}×{columns}");
    for (int r = 0; r < rows; r++) for (int c = 0; c < columns; c++) Check(grid.Cells.Count(x => r >= x.Row && r < x.Row + x.RowSpan && c >= x.Column && c < x.Column + x.ColumnSpan) == 1, "every logical position has one owning cell");
    var ids = DocumentNodes.Descendants(table).Where(n => DocumentNodes.Type(n) != "text").Select(Id).ToList();
    Check(ids.All(x => !string.IsNullOrEmpty(x)) && ids.Count == ids.Distinct().Count(), "nested stable IDs are nonempty and unique");
}
Run("Unknown node and attrs survive lossless cloning", () =>
{
    var n = JsonNode.Parse("{\"type\":\"customEquation\",\"attrs\":{\"id\":\"equation-1\",\"payload\":{\"author\":\"原始来源\"}},\"custom\":17,\"content\":[{\"type\":\"paragraph\",\"attrs\":{\"id\":\"p1\",\"custom\":false},\"content\":[{\"type\":\"text\",\"text\":\"设备A\",\"marks\":[{\"type\":\"sourceTag\",\"attrs\":{\"ref\":\"source-1\"}},{\"type\":\"bold\"}]}]}]}")!.AsObject();
    var before = n.ToJsonString(); var copy = (JsonObject)n.DeepClone();
    Check(JsonNode.DeepEquals(n, copy), "readback equal"); Check(n.ToJsonString() == before, "original unchanged");
    var fresh = DocumentNodes.FreshCopy(n); Check(Id(fresh) != Id(n), "root copy ID replaced");
    Check(Id(DocumentNodes.Children(fresh).First()) != Id(DocumentNodes.Children(n).First()), "nested copy ID replaced");
    Check(fresh["attrs"]!["payload"]!["author"]!.GetValue<string>() == "原始来源", "unknown attrs preserved");
});
Run("Rich editing retains marks, links, and unknown run properties", () =>
{
    var content = JsonNode.Parse("[{\"type\":\"text\",\"text\":\"AB\",\"marks\":[{\"type\":\"bold\"},{\"type\":\"audit\",\"attrs\":{\"ref\":\"v1\"}}],\"attrs\":{\"source\":\"preserved\"}},{\"type\":\"text\",\"text\":\"CD\",\"marks\":[{\"type\":\"link\",\"attrs\":{\"href\":\"https://example.com\"}}]}]")!.AsArray();
    var rebuilt = DocumentNodes.Coalesce(DocumentNodes.Reconcile(content.OfType<JsonObject>(), "AXB CD"));
    var atoms = DocumentNodes.Explode(rebuilt.OfType<JsonObject>());
    Check(DocumentNodes.AtomText(atoms) == "AXB CD", "new text retained");
    Check(DocumentNodes.HasMark(atoms[1], "bold") && DocumentNodes.HasMark(atoms[1], "audit"), "inserted text inherits full source marks");
    Check(DocumentNodes.HasMark(atoms[^1], "link"), "suffix hyperlink survives");
    Check(atoms[0]["attrs"]!["source"]!.GetValue<string>() == "preserved", "unknown source props survive");
    DocumentNodes.SetMark(atoms[0], "bold", false); Check(DocumentNodes.HasMark(atoms[0], "audit"), "toggling known mark retains unknown marks");
});
Run("Split and join preserve first identity and inline content", () =>
{
    var p = DocumentNodes.Paragraph("第一段😀后缀"); p["custom"] = 99; var id = Id(p);
    var second = DocumentNodes.SplitParagraph(p, 3);
    Check(Id(p) == id && Id(second) != id, "first identity stable, second new"); Check(second["custom"]!.GetValue<int>() == 99, "split unknown attrs preserved");
    DocumentNodes.JoinParagraph(p, second); Check(Id(p) == id && DocumentNodes.Text(p) == "第一段😀后缀", "join restores text and first identity");
    var h = DocumentNodes.Paragraph("标题内容"); h["type"] = "heading"; DocumentNodes.Attributes(h)["level"] = 2;
    var after = DocumentNodes.SplitParagraph(h, 2); Check(DocumentNodes.Type(h) == "heading" && DocumentNodes.Type(after) == "paragraph", "heading Enter becomes body paragraph");
});
Run("Hard break and inline image identities survive text edits", () =>
{
    var content = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = "A" }, new JsonObject { ["type"] = "hardBreak", ["attrs"] = new JsonObject { ["id"] = "br1" } }, new JsonObject { ["type"] = "image", ["attrs"] = new JsonObject { ["id"] = "img1", ["src"] = "assets/a.png" } }, new JsonObject { ["type"] = "text", ["text"] = "B" });
    var atoms = DocumentNodes.Reconcile(content.OfType<JsonObject>(), "XA\v\uFFFCB");
    Check(atoms.Any(a => Id(a) == "br1") && atoms.Any(a => Id(a) == "img1"), "inline preserved");
    var pieces = DocumentNodes.SplitInline(content, 2); Check(pieces.left.OfType<JsonObject>().Any(a => Id(a) == "br1"), "break stays in left"); Check(pieces.right.OfType<JsonObject>().Any(a => Id(a) == "img1"), "image stays in right");
});
Run("Code block newline edits remain literal text", () =>
{
    var original = new[] { new JsonObject { ["type"] = "text", ["text"] = "line1\nline2" } };
    var edited = DocumentNodes.Coalesce(DocumentNodes.Reconcile(original, "line1\nline2\nline3", true));
    Check(edited.OfType<JsonObject>().All(n => DocumentNodes.Type(n) == "text"), "no invalid hardBreak in codeBlock");
    Check(DocumentNodes.AtomText(DocumentNodes.Explode(edited.OfType<JsonObject>())) == "line1\nline2\nline3", "literal newlines retained");
});
Run("Native pasted newline readback preserves hard-break identities and avoids phantom undo", () =>
{
    var paragraph = DocumentNodes.Paragraph();
    paragraph["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = "第一行" },
        new JsonObject { ["type"] = "hardBreak", ["attrs"] = new JsonObject { ["id"] = "stable-break" } },
        new JsonObject { ["type"] = "text", ["text"] = "第二行" });
    var baseline = new Dictionary<string, JsonObject> { [Id(paragraph)] = paragraph.DeepClone().AsObject() };
    var order = new[] { Id(paragraph) };
    foreach (var readback in new[] { "第一行\n第二行", "第一行\r\n第二行", "第一行\v第二行" })
    {
        paragraph["content"] = DocumentNodes.Coalesce(DocumentNodes.Reconcile(DocumentNodes.Children(paragraph), readback));
        Check(DocumentNodes.Children(paragraph).Single(n => DocumentNodes.Type(n) == "hardBreak")["attrs"]!["id"]!.GetValue<string>() == "stable-break", "native line separators retain the original break identity");
        Check(BlockEditDelta.Capture(baseline, order, new JsonArray(paragraph.DeepClone())).IsEmpty, "unchanged newline readback creates no extra undo command");
    }
});
Run("Clipboard HTML and plain text represent rich paragraphs and merged tables", () =>
{
    var paragraph = DocumentNodes.Paragraph("<设备&A>"); var run = DocumentNodes.Children(paragraph).First();
    DocumentNodes.SetMark(run, "bold", true); DocumentNodes.SetMark(run, "link", true, new JsonObject { ["href"] = "https://example.com/?a=1&b=2" });
    DocumentNodes.Attributes(paragraph)["fontSize"] = 14;
    var html = DocumentClipboard.Html(paragraph);
    Check(html.Contains("&lt;设备&amp;A&gt;") && html.Contains("<strong>") && html.Contains("font-size:14pt"), "HTML escapes text and retains rich formatting");
    Check(html.Contains("href=\"https://example.com/?a=1&amp;b=2\""), "HTML retains valid link safely");
    var table = NativeTableModel.Create(2, 2); NativeTableModel.Merge(table, 0, 0, 1, 0);
    Check(DocumentClipboard.Html(table).Contains("rowspan=\"2\""), "merged table HTML retains rowspan");
    var doc = new JsonObject { ["type"] = "doc", ["content"] = new JsonArray(paragraph.DeepClone(), DocumentNodes.Paragraph("第二段")) };
    Check(DocumentClipboard.Plain(doc) == "<设备&A>\n第二段", "copied document separates complete root paragraphs");
});
Run("External clipboard text creates one block per nonempty paragraph", () =>
{
    var nodes = DocumentClipboard.FromText("\r\n  第一段  \r\n\r\n\t \r第二段\n第三段\u2028第四段\u2029第五段\n");
    Check(nodes.Count == 5, "empty and whitespace-only paragraphs are ignored across all supported separators");
    Check(nodes.OfType<JsonObject>().Select(DocumentClipboard.Plain).SequenceEqual(new[] { "  第一段  ", "第二段", "第三段", "第四段", "第五段" }), "nonempty paragraph text and surrounding spaces are preserved in order");
    Check(nodes.OfType<JsonObject>().All(n => DocumentNodes.Type(n) == "paragraph"), "external text creates body paragraph blocks");
    Check(nodes.OfType<JsonObject>().Select(Id).Distinct().Count() == 5, "every pasted paragraph has a unique ID");
    Check(DocumentClipboard.FromText("").Count == 0 && DocumentClipboard.FromText(" \t\r\n\u2028\u2029").Count == 0, "empty clipboard text creates no blocks");
});
Run("Text paste splits only empty text roots and preserves their first identity", () =>
{
    var empty = DocumentNodes.Paragraph(" \t"); DocumentNodes.Attributes(empty)["fontFamily"] = "宋体"; empty["custom"] = "retained";
    var next = DocumentNodes.Paragraph("后续原文"); var nodes = new JsonArray(empty, next);
    var baseline = nodes.OfType<JsonObject>().ToDictionary(Id, n => n.DeepClone().AsObject()); var order = nodes.OfType<JsonObject>().Select(Id).ToArray();
    Check(DocumentClipboard.IsEmptyTextBlock(empty), "whitespace-only body is empty");
    Check(!DocumentClipboard.IsEmptyTextBlock(next), "existing text always stays inside its original root");
    var pasted = DocumentClipboard.FromText("第一段\r\n\r\n第二段\n第三段").OfType<JsonObject>().ToList();
    var last = DocumentClipboard.FillEmptyTextBlock(nodes, empty, pasted);
    Check(nodes.Count == 4 && ReferenceEquals(nodes[0], empty) && Id(empty) == order[0], "first paragraph fills empty root and only subsequent paragraphs create roots");
    Check(nodes.OfType<JsonObject>().Select(DocumentNodes.Text).SequenceEqual(new[] { "第一段", "第二段", "第三段", "后续原文" }), "nonempty paragraphs preserve order before following content");
    Check(DocumentNodes.Attributes(empty)["fontFamily"]!.GetValue<string>() == "宋体" && empty["custom"]!.GetValue<string>() == "retained", "empty root retains formatting and unknown properties");
    Check(last == Id(nodes[2]!.AsObject()), "last pasted root is selected");
    var delta = BlockEditDelta.Capture(baseline, order, nodes); delta.Apply(nodes, false);
    Check(nodes.Count == 2 && JsonNode.DeepEquals(nodes[0], baseline[order[0]]), "undo restores exact blank root and removes continuation paragraphs");
    delta.Apply(nodes, true); Check(nodes.Count == 4 && Id(nodes[0]!.AsObject()) == order[0], "redo retains all pasted identities");
    var imageParagraph = DocumentNodes.Paragraph(); DocumentNodes.Content(imageParagraph).Add(new JsonObject { ["type"] = "image", ["attrs"] = new JsonObject { ["id"] = "image", ["src"] = "assets/a.png" } });
    Check(!DocumentClipboard.IsEmptyTextBlock(imageParagraph) && !DocumentClipboard.IsEmptyTextBlock(NativeTableModel.Create(1, 1)), "images and tables are not treated as empty text");
    var single = DocumentNodes.Paragraph(); var singleNodes = new JsonArray(single); var singleId = Id(single);
    DocumentClipboard.FillEmptyTextBlock(singleNodes, single, DocumentClipboard.FromText("一段文字").OfType<JsonObject>().ToList());
    Check(singleNodes.Count == 1 && Id(single) == singleId && DocumentNodes.Text(single) == "一段文字", "single paragraph fills blank without creating any new root");
    var before = singleNodes.DeepClone();
    bool refused = false; try { DocumentClipboard.FillEmptyTextBlock(singleNodes, single, [DocumentNodes.Paragraph("不应拆分")]); } catch (InvalidOperationException) { refused = true; }
    Check(refused && JsonNode.DeepEquals(singleNodes, before), "nonempty target cannot enter paragraph splitting path");
});
Run("Multi-block paste preserves selected block and inserts in clipboard order", () =>
{
    var target = DocumentNodes.Paragraph("原始目标全文"); DocumentNodes.Attributes(target)["fontFamily"] = "宋体";
    var next = DocumentNodes.Paragraph("后续块"); var nodes = new JsonArray(target, next);
    var targetBefore = target.DeepClone(); var nextBefore = next.DeepClone();
    var first = DocumentNodes.Paragraph("拷贝第一块"); var second = NativeTableModel.Create(1, 1);
    var lastId = DocumentClipboard.InsertAfterSelected(nodes, [first, second], Id(target));
    Check(nodes.OfType<JsonObject>().Select(Id).SequenceEqual(new[] { Id(target), Id(first), Id(second), Id(next) }), "complete copied blocks appear after target in source order");
    Check(lastId == Id(second), "caller can select final inserted block");
    Check(ReferenceEquals(nodes[0], target) && JsonNode.DeepEquals(target, targetBefore), "target identity, text, and formatting remain intact");
    Check(ReferenceEquals(nodes[3], next) && JsonNode.DeepEquals(next, nextBefore), "following block remains intact");
});
Run("Paste appends without a selected root and tolerates nonobject entries", () =>
{
    var target = DocumentNodes.Paragraph("现有块"); var nodes = new JsonArray(JsonValue.Create("unknown"), null, target);
    var first = DocumentNodes.Paragraph("追加一"); var second = DocumentNodes.Paragraph("追加二");
    Check(DocumentClipboard.InsertAfterSelected(nodes, [first], null) == Id(first) && ReferenceEquals(nodes[3], first), "no selection appends after every existing entry");
    Check(DocumentClipboard.InsertAfterSelected(nodes, [second], "missing-root") == Id(second) && ReferenceEquals(nodes[4], second), "stale selection appends");
    var afterTarget = DocumentNodes.Paragraph("目标之后"); DocumentClipboard.InsertAfterSelected(nodes, [afterTarget], Id(target));
    Check(ReferenceEquals(nodes[3], afterTarget) && nodes[0]!.GetValue<string>() == "unknown" && nodes[1] == null, "root lookup skips nonobjects without removing them");
    var before = nodes.DeepClone();
    Check(DocumentClipboard.InsertAfterSelected(nodes, [], Id(target)) == null && JsonNode.DeepEquals(nodes, before), "empty incoming content is a no-op");
});
Run("Rich clipboard blocks retain nested content and formatting on insertion", () =>
{
    var source = DocumentNodes.Paragraph("带格式文字"); DocumentNodes.Attributes(source)["fontSize"] = 18;
    source["custom"] = new JsonObject { ["sourceRevision"] = "r7" };
    var run = DocumentNodes.Children(source).First(); DocumentNodes.SetMark(run, "bold", true);
    DocumentNodes.SetMark(run, "link", true, new JsonObject { ["href"] = "https://example.com/reference" });
    var sourceBefore = source.DeepClone(); var copy = DocumentNodes.FreshCopy(source); var expected = copy.DeepClone();
    var clipboard = new JsonArray(copy); var target = DocumentNodes.Paragraph("粘贴位置"); var nodes = new JsonArray(target);
    DocumentClipboard.InsertAfterSelected(nodes, clipboard.OfType<JsonObject>().ToList(), Id(target));
    Check(JsonNode.DeepEquals(nodes[1], expected) && Id(nodes[1]!.AsObject()) == Id(copy), "insertion preserves prepared copy ID, attributes, marks, and custom properties");
    Check(JsonNode.DeepEquals(source, sourceBefore) && JsonNode.DeepEquals(clipboard[0], expected), "original and parent-owned clipboard payload remain unchanged");
    Check(!ReferenceEquals(nodes[1], clipboard[0]), "parent-owned clipboard node is cloned without reassigning IDs");
});
Run("Pasted block insertion can undo and redo without overwriting existing edits", () =>
{
    var target = DocumentNodes.Paragraph("目标"); var next = DocumentNodes.Paragraph("后续"); var nodes = new JsonArray(target, next);
    var baseline = nodes.OfType<JsonObject>().ToDictionary(Id, n => n.DeepClone().AsObject()); var order = nodes.OfType<JsonObject>().Select(Id).ToArray();
    var first = DocumentNodes.Paragraph("粘贴一"); var second = DocumentNodes.Paragraph("粘贴二");
    DocumentClipboard.InsertAfterSelected(nodes, [first, second], Id(target)); var delta = BlockEditDelta.Capture(baseline, order, nodes);
    Check(delta.Before.Count == 2 && delta.Before.Values.All(n => n == null), "paste history records only the two newly inserted blocks");
    target["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = "外部更新目标" });
    delta.Apply(nodes, false);
    Check(nodes.OfType<JsonObject>().Select(Id).SequenceEqual(order) && DocumentNodes.Text(nodes[0]!.AsObject()) == "外部更新目标", "undo removes pasted blocks and keeps independent target edit");
    delta.Apply(nodes, true);
    Check(nodes.OfType<JsonObject>().Select(Id).SequenceEqual(new[] { Id(target), Id(first), Id(second), Id(next) }), "redo restores paste order and stable IDs");
    Check(DocumentNodes.Text(nodes[0]!.AsObject()) == "外部更新目标", "redo preserves independent target edit");
    baseline = nodes.OfType<JsonObject>().ToDictionary(Id, n => n.DeepClone().AsObject()); order = nodes.OfType<JsonObject>().Select(Id).ToArray();
    var appended = DocumentNodes.Paragraph("末尾追加"); DocumentClipboard.InsertAfterSelected(nodes, [appended], null);
    var appendDelta = BlockEditDelta.Capture(baseline, order, nodes); appendDelta.Apply(nodes, false);
    Check(nodes.OfType<JsonObject>().Select(Id).SequenceEqual(order), "append paste undo restores original order");
    appendDelta.Apply(nodes, true); Check(Id(nodes[^1]!.AsObject()) == Id(appended), "append paste redo restores final copied block");
});
Run("Rectangular merge preserves all content and nested IDs", () =>
{
    var table = NativeTableModel.Create(3, 4); var grid = NativeTableModel.Layout(table);
    foreach (var c in grid.Cells) DocumentNodes.Content(c.Node)[0]!["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = $"R{c.Row}C{c.Column}" });
    var first = grid.At(0, 0)!; var paragraphIds = grid.Cells.Where(c => c.Row <= 1 && c.Column <= 1).Select(c => Id(DocumentNodes.Children(c.Node).First())).ToHashSet();
    var retained = grid.Cells.Where(c => c.Column > 1 || c.Row > 1).Select(c => Id(c.Node)).ToHashSet();
    Check(NativeTableModel.Merge(table, 0, 0, 1, 1), "merge succeeds"); GridValid(table, 3, 4);
    var merged = NativeTableModel.Layout(table).At(0, 0)!; Check(Id(merged.Node) == Id(first.Node), "top left identity stable");
    Check(DocumentNodes.Children(merged.Node).Select(Id).ToHashSet().SetEquals(paragraphIds), "all merged paragraph identities preserved");
    Check(DocumentNodes.Text(merged.Node) == "R0C0R0C1R1C0R1C1", "all cell text retained in row order");
    Check(retained.IsSubsetOf(NativeTableModel.Layout(table).Cells.Select(c => Id(c.Node)).ToHashSet()), "outside cells stable");
    Check(!NativeTableModel.Merge(table, 0, 1, 1, 2), "partial existing span cannot merge");
    Check(NativeTableModel.Split(table, Id(merged.Node)), "split succeeds"); GridValid(table, 3, 4);
    Check(DocumentNodes.Children(NativeTableModel.Layout(table).At(0, 0)!.Node).Select(Id).ToHashSet().SetEquals(paragraphIds), "split retains complete content in first cell");
});
Run("Insert and delete rows crossing vertical spans", () =>
{
    var table = NativeTableModel.Create(4, 3); Check(NativeTableModel.Merge(table, 0, 0, 2, 1), "initial merge");
    var original = NativeTableModel.Layout(table).At(0, 0)!; string id = Id(original.Node);
    NativeTableModel.AddRow(table, 1); GridValid(table, 5, 3); Check(NativeTableModel.Layout(table).At(0, 0)!.RowSpan == 4, "crossing span grows");
    Check(NativeTableModel.DeleteRow(table, 0), "delete first row"); GridValid(table, 4, 3);
    Check(Id(NativeTableModel.Layout(table).At(0, 0)!.Node) == id && NativeTableModel.Layout(table).At(0, 0)!.RowSpan == 3, "span owner moves up retaining identity");
    NativeTableModel.AddRow(table, 4); GridValid(table, 5, 3); Check(NativeTableModel.DeleteRow(table, 4), "remove last"); GridValid(table, 4, 3);
});
Run("Insert and delete columns crossing horizontal spans", () =>
{
    var table = NativeTableModel.Create(3, 4); Check(NativeTableModel.Merge(table, 0, 0, 1, 2), "initial merge");
    string id = Id(NativeTableModel.Layout(table).At(0, 0)!.Node);
    NativeTableModel.AddColumn(table, 1); GridValid(table, 3, 5); Check(NativeTableModel.Layout(table).At(0, 0)!.ColumnSpan == 4, "span grows");
    Check(NativeTableModel.DeleteColumn(table, 0), "delete leading col"); GridValid(table, 3, 4);
    Check(Id(NativeTableModel.Layout(table).At(0, 0)!.Node) == id && NativeTableModel.Layout(table).At(0, 0)!.ColumnSpan == 3, "owner retains identity");
    NativeTableModel.AddColumn(table, 4); GridValid(table, 3, 5); Check(NativeTableModel.DeleteColumn(table, 4), "delete trailing col"); GridValid(table, 3, 4);
});
Run("Copy of merged table creates every nested ID anew", () =>
{
    var table = NativeTableModel.Create(3, 3); NativeTableModel.Merge(table, 0, 0, 1, 1); var copy = DocumentNodes.FreshCopy(table);
    var originalIds = DocumentNodes.Descendants(table).Where(n => DocumentNodes.Type(n) != "text").Select(Id).ToHashSet();
    var copyIds = DocumentNodes.Descendants(copy).Where(n => DocumentNodes.Type(n) != "text").Select(Id).ToHashSet();
    Check(!originalIds.Overlaps(copyIds), "no original nested ID reused"); GridValid(copy, 3, 3);
});
Run("Snapshot undo of structural operations restores all UUIDs", () =>
{
    var table = NativeTableModel.Create(3, 3); var snapshot = table.DeepClone();
    NativeTableModel.Merge(table, 0, 0, 1, 1); NativeTableModel.AddColumn(table, 1); NativeTableModel.DeleteRow(table, 2);
    var undo = (JsonObject)snapshot.DeepClone(); Check(JsonNode.DeepEquals(undo, snapshot), "snapshot restores exact JSON"); GridValid(undo, 3, 3);
});
Run("Many span edits maintain a valid logical matrix", () =>
{
    var rng = new Random(41);
    for (int trial = 0; trial < 12; trial++)
    {
        var table = NativeTableModel.Create(4, 4); NativeTableModel.Merge(table, 0, 0, 1, 1); int rows = 4, cols = 4;
        for (int step = 0; step < 20; step++)
        {
            switch (rng.Next(4))
            {
                case 0: NativeTableModel.AddRow(table, rng.Next(rows + 1)); rows++; break;
                case 1: if (rows > 1) { NativeTableModel.DeleteRow(table, rng.Next(rows)); rows--; } break;
                case 2: NativeTableModel.AddColumn(table, rng.Next(cols + 1)); cols++; break;
                case 3: if (cols > 1) { NativeTableModel.DeleteColumn(table, rng.Next(cols)); cols--; } break;
            }
            GridValid(table, rows, cols);
        }
    }
});
Run("Block delta undo retains independently updated blocks", () =>
{
    var a = DocumentNodes.Paragraph("before A"); var b = DocumentNodes.Paragraph("before B");
    var nodes = new JsonArray(a, b); var baseline = nodes.OfType<JsonObject>().ToDictionary(n => Id(n), n => n.DeepClone().AsObject());
    var order = nodes.OfType<JsonObject>().Select(Id).ToArray();
    a["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = "after A" });
    var delta = BlockEditDelta.Capture(baseline, order, nodes, Id(a));
    Check(delta.Before.Count == 1 && delta.BeforeOrder == null && !delta.Before.ContainsKey(Id(b)), "history stores only changed block");
    b["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = "remote B" });
    delta.Apply(nodes, false); Check(DocumentNodes.Text(nodes[0]!.AsObject()) == "before A" && DocumentNodes.Text(nodes[1]!.AsObject()) == "remote B", "undo leaves external block intact");
    delta.Apply(nodes, true); Check(DocumentNodes.Text(nodes[0]!.AsObject()) == "after A", "redo restores only A");
});
Run("Server identity mapping is applied to structural undo and redo", () =>
{
    var a = DocumentNodes.Paragraph("A"); var baseline = new Dictionary<string, JsonObject> { [Id(a)] = a.DeepClone().AsObject() };
    var b = DocumentNodes.Paragraph("B"); var original = Id(b); var nodes = new JsonArray(a, b);
    var delta = BlockEditDelta.Capture(baseline, [Id(a)], nodes);
    var permanent = Guid.NewGuid().ToString(); delta.Remap(new Dictionary<string, string> { [original] = permanent }); DocumentNodes.Attributes(b)["id"] = permanent;
    delta.Apply(nodes, false); Check(nodes.Count == 1, "undo removes server-assigned identity");
    delta.Apply(nodes, true); Check(Id(nodes[1]!.AsObject()) == permanent, "redo restores server identity");
});
Run("Large table layout uses indexed positions and does not enter unrelated block undo", () =>
{
    var table = NativeTableModel.Create(400, 12); var paragraph = DocumentNodes.Paragraph("small"); var nodes = new JsonArray(paragraph, table);
    var baseline = nodes.OfType<JsonObject>().ToDictionary(Id, n => n.DeepClone().AsObject()); var order = nodes.OfType<JsonObject>().Select(Id).ToArray();
    var timer = System.Diagnostics.Stopwatch.StartNew(); var layout = NativeTableModel.Layout(table); timer.Stop();
    Check(layout.Cells.Count == 4800 && layout.At(399, 11) != null, "4800 cells indexed");
    paragraph["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = "edited" });
    var delta = BlockEditDelta.Capture(baseline, order, nodes, Id(paragraph));
    Check(delta.Before.Count == 1 && delta.Before.Values.Sum(n => n!.ToJsonString().Length) < 1024, "unrelated table never copied into undo");
    Console.Error.WriteLine($"Large indexed table layout: 4800 cells, {timer.Elapsed.TotalMilliseconds:F2} ms; undo blocks: {delta.Before.Count}");
});
Run("Document styles resolve heading levels, table context, spacing and inline emphasis separately", () =>
{
    var node = DocumentNodes.Paragraph("中文 Latin");
    var styles = JsonNode.Parse("{\"semantic\":{\"body\":{\"font\":{\"eastAsia\":\"仿宋\",\"latin\":\"Arial\",\"sizePt\":15,\"bold\":true},\"paragraph\":{\"line\":360,\"beforePt\":8,\"afterPt\":10,\"alignment\":\"both\",\"indent\":{\"firstLine\":600}}},\"headings\":{\"2\":{\"font\":{\"eastAsia\":\"黑体\",\"sizePt\":18}}}}}")!.AsObject();
    var before = node.ToJsonString(); var body = DocumentStyleRules.Resolve(styles, node);
    Check(body.Size == 15 && body.EastAsia == "仿宋" && body.Latin == "Arial" && body.Bold, "document font rule applied");
    Check(body.Line == 360 && body.Before == 8 && body.After == 10 && body.FirstLine == 30 && body.Alignment == "both", "paragraph units retained");
    Check(!DocumentStyleRules.InlineEmphasis(true, true, false), "inherited bold does not add a mark");
    Check(DocumentStyleRules.InlineEmphasis(true, true, true), "existing inline bold retained");
    Check(DocumentStyleRules.InlineEmphasis(true, false, false), "local bold retained without inherited bold");
    Check(!DocumentStyleRules.InlineEmphasis(false, false, true), "local bold can be removed");
    Check(node.ToJsonString() == before, "resolving presentation does not mutate content");
    node["type"] = "heading"; DocumentNodes.Attributes(node)["level"] = 2;
    Check(DocumentStyleRules.Resolve(styles, node).Size == 18, "heading 2 uses its own style");
    node["type"] = "paragraph"; Check(DocumentStyleRules.Resolve(null, node, true).Size == 10.5, "table text stays independent");
    foreach (var line in new[] { 240, 360, 480 }) { styles["semantic"]!["body"]!["paragraph"]!["line"] = line; Check(DocumentStyleRules.Resolve(styles, node).Line == line, "all three line spacings represented"); }
});
Console.WriteLine(new JsonObject { ["suite"] = "NativeDocument.Editor.Model", ["passedCases"] = cases.Count, ["assertions"] = assertions, ["cases"] = new JsonArray(cases.Select(n => JsonValue.Create(n)).ToArray()) }.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
