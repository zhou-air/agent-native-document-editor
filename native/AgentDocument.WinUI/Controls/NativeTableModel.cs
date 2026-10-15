using System.Text.Json.Nodes;

namespace AgentDocument.WinUI.Controls;

public sealed record NativeCell(JsonObject Node, int Row, int Column, int RowSpan, int ColumnSpan);
public sealed class NativeTableLayout
{
    public List<NativeCell> Cells { get; } = [];
    public int Rows { get; internal set; }
    public int Columns { get; internal set; }
    private readonly Dictionary<(int row, int col), NativeCell> _positions = [];
    public NativeCell? At(int row, int col) => _positions.GetValueOrDefault((row, col));
    internal void Add(NativeCell cell)
    {
        Cells.Add(cell);
        for (int row = cell.Row; row < cell.Row + cell.RowSpan; row++)
            for (int col = cell.Column; col < cell.Column + cell.ColumnSpan; col++) _positions[(row, col)] = cell;
    }
}

/// <summary>Logical-grid table commands preserve surviving cell, row, and paragraph UUIDs.</summary>
public static class NativeTableModel
{
    private static int Span(JsonObject n, string key) => Math.Max(1, (n["attrs"] as JsonObject)?[key]?.GetValue<int>() ?? 1);
    public static NativeTableLayout Layout(JsonObject table)
    {
        var rows = DocumentNodes.Children(table).ToList(); var result = new NativeTableLayout { Rows = rows.Count };
        for (int r = 0; r < rows.Count; r++)
        {
            int col = 0;
            foreach (var cell in DocumentNodes.Children(rows[r]))
            {
                while (result.At(r, col) != null) col++;
                int rs = Span(cell, "rowspan"), cs = Span(cell, "colspan");
                result.Add(new NativeCell(cell, r, col, rs, cs));
                result.Columns = Math.Max(result.Columns, col + cs); result.Rows = Math.Max(result.Rows, r + rs); col += cs;
            }
        }
        return result;
    }
    public static JsonObject Cell(bool header = false) => new()
    {
        ["type"] = header ? "tableHeader" : "tableCell",
        ["attrs"] = new JsonObject { ["id"] = Guid.NewGuid().ToString(), ["colspan"] = 1, ["rowspan"] = 1 },
        ["content"] = new JsonArray(DocumentNodes.Paragraph())
    };
    public static JsonObject Create(int rows = 3, int columns = 3)
    {
        var table = new JsonObject { ["type"] = "table", ["attrs"] = new JsonObject { ["id"] = Guid.NewGuid().ToString() }, ["content"] = new JsonArray() };
        for (int r = 0; r < rows; r++)
        {
            var row = new JsonObject { ["type"] = "tableRow", ["attrs"] = new JsonObject { ["id"] = Guid.NewGuid().ToString() }, ["content"] = new JsonArray() };
            for (int c = 0; c < columns; c++) DocumentNodes.Content(row).Add(Cell(r == 0));
            DocumentNodes.Content(table).Add(row);
        }
        return table;
    }
    private static void Write(JsonObject table, List<NativeCell> cells, int rowCount, IReadOnlyList<JsonObject> rowTemplates)
    {
        var rows = new JsonArray();
        var cellsByRow = cells.GroupBy(c => c.Row).ToDictionary(g => g.Key, g => g.OrderBy(c => c.Column).ToArray());
        for (int r = 0; r < rowCount; r++)
        {
            var row = r < rowTemplates.Count ? (JsonObject)rowTemplates[r].DeepClone()
                : new JsonObject { ["type"] = "tableRow", ["attrs"] = new JsonObject { ["id"] = Guid.NewGuid().ToString() } };
            var content = new JsonArray();
            foreach (var c in cellsByRow.GetValueOrDefault(r) ?? [])
            {
                var cell = (JsonObject)c.Node.DeepClone(); var attrs = DocumentNodes.Attributes(cell);
                attrs["rowspan"] = c.RowSpan; attrs["colspan"] = c.ColumnSpan;
                if (attrs["colwidth"] is JsonArray widths && widths.Count != c.ColumnSpan) attrs["colwidth"] = null;
                content.Add(cell);
            }
            row["content"] = content; rows.Add(row);
        }
        table["content"] = rows;
    }
    private static NativeCell? At(List<NativeCell> cells, int r, int c) => cells.FirstOrDefault(x => r >= x.Row && r < x.Row + x.RowSpan && c >= x.Column && c < x.Column + x.ColumnSpan);
    public static void AddRow(JsonObject table, int boundary)
    {
        var grid = Layout(table); boundary = Math.Clamp(boundary, 0, grid.Rows);
        var cells = grid.Cells.Select(c => c.Row >= boundary ? c with { Row = c.Row + 1 }
            : c.Row + c.RowSpan > boundary ? c with { RowSpan = c.RowSpan + 1 } : c).ToList();
        for (int col = 0; col < grid.Columns; col++) if (At(cells, boundary, col) == null) cells.Add(new NativeCell(Cell(), boundary, col, 1, 1));
        var rows = DocumentNodes.Children(table).Select(r => (JsonObject)r.DeepClone()).ToList();
        rows.Insert(boundary, new JsonObject { ["type"] = "tableRow", ["attrs"] = new JsonObject { ["id"] = Guid.NewGuid().ToString() } });
        Write(table, cells, grid.Rows + 1, rows);
    }
    public static bool DeleteRow(JsonObject table, int row)
    {
        var grid = Layout(table); if (grid.Rows < 2 || row < 0 || row >= grid.Rows) return false;
        var cells = new List<NativeCell>();
        foreach (var c in grid.Cells)
        {
            if (c.Row > row) cells.Add(c with { Row = c.Row - 1 });
            else if (c.Row <= row && c.Row + c.RowSpan > row)
            { if (c.RowSpan > 1) cells.Add(c with { RowSpan = c.RowSpan - 1 }); }
            else cells.Add(c);
        }
        var rows = DocumentNodes.Children(table).ToList(); rows.RemoveAt(row); Write(table, cells, grid.Rows - 1, rows); return true;
    }
    public static void AddColumn(JsonObject table, int boundary)
    {
        var grid = Layout(table); boundary = Math.Clamp(boundary, 0, grid.Columns);
        var cells = grid.Cells.Select(c => c.Column >= boundary ? c with { Column = c.Column + 1 }
            : c.Column + c.ColumnSpan > boundary ? c with { ColumnSpan = c.ColumnSpan + 1 } : c).ToList();
        for (int r = 0; r < grid.Rows; r++) if (At(cells, r, boundary) == null) cells.Add(new NativeCell(Cell(r == 0 && grid.Cells.Any(c => DocumentNodes.Type(c.Node) == "tableHeader")), r, boundary, 1, 1));
        Write(table, cells, grid.Rows, DocumentNodes.Children(table).ToList());
    }
    public static bool DeleteColumn(JsonObject table, int column)
    {
        var grid = Layout(table); if (grid.Columns < 2 || column < 0 || column >= grid.Columns) return false;
        var cells = new List<NativeCell>();
        foreach (var c in grid.Cells)
        {
            if (c.Column > column) cells.Add(c with { Column = c.Column - 1 });
            else if (c.Column <= column && c.Column + c.ColumnSpan > column)
            { if (c.ColumnSpan > 1) cells.Add(c with { ColumnSpan = c.ColumnSpan - 1 }); }
            else cells.Add(c);
        }
        Write(table, cells, grid.Rows, DocumentNodes.Children(table).ToList()); return true;
    }
    public static bool Merge(JsonObject table, int top, int left, int bottom, int right)
    {
        var grid = Layout(table);
        var selected = grid.Cells.Where(c => c.Row <= bottom && c.Row + c.RowSpan > top && c.Column <= right && c.Column + c.ColumnSpan > left).OrderBy(c => c.Row).ThenBy(c => c.Column).ToList();
        if (selected.Count < 2 || selected.Any(c => c.Row < top || c.Column < left || c.Row + c.RowSpan - 1 > bottom || c.Column + c.ColumnSpan - 1 > right)) return false;
        if ((bottom - top + 1) * (right - left + 1) != selected.Sum(c => c.RowSpan * c.ColumnSpan)) return false;
        var first = (JsonObject)selected[0].Node.DeepClone();
        var content = new JsonArray();
        foreach (var c in selected) foreach (var child in DocumentNodes.Children(c.Node)) content.Add(child.DeepClone());
        first["content"] = content;
        var remaining = grid.Cells.Except(selected).ToList(); remaining.Add(new NativeCell(first, top, left, bottom - top + 1, right - left + 1));
        Write(table, remaining, grid.Rows, DocumentNodes.Children(table).ToList()); return true;
    }
    public static bool Split(JsonObject table, string cellId)
    {
        var grid = Layout(table); var chosen = grid.Cells.FirstOrDefault(c => DocumentNodes.Id(c.Node) == cellId);
        if (chosen == null || chosen.RowSpan == 1 && chosen.ColumnSpan == 1) return false;
        var cells = grid.Cells.Where(c => c != chosen).ToList();
        cells.Add(chosen with { RowSpan = 1, ColumnSpan = 1 });
        for (int r = chosen.Row; r < chosen.Row + chosen.RowSpan; r++)
            for (int c = chosen.Column; c < chosen.Column + chosen.ColumnSpan; c++)
                if (r != chosen.Row || c != chosen.Column) cells.Add(new NativeCell(Cell(DocumentNodes.Type(chosen.Node) == "tableHeader"), r, c, 1, 1));
        Write(table, cells, grid.Rows, DocumentNodes.Children(table).ToList()); return true;
    }
}
