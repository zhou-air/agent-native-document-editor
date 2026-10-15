using System.Text.Json.Nodes;
using Microsoft.UI.Input;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;
using Windows.Storage.Streams;
using Windows.System;
using Windows.UI;
using Windows.UI.Core;
using Colors = Microsoft.UI.Colors;

namespace AgentDocument.WinUI.Controls;

public sealed class NativeImageDropEventArgs(IReadOnlyList<string> files) : EventArgs
{
    public IReadOnlyList<string> Files { get; } = files;
}

/// <summary>Native WinUI text, image, and logical-grid table editor, backed by the original JSON.</summary>
public sealed class NativeDocumentEditor : UserControl
{
    private readonly StackPanel _surface = new() { Spacing = 4, HorizontalAlignment = HorizontalAlignment.Stretch };
    private JsonArray _nodes = new();
    private readonly Dictionary<string, JsonObject> _committed = new(StringComparer.Ordinal);
    private string[] _committedOrder = [];
    private readonly List<BlockEditDelta> _undo = [];
    private readonly List<BlockEditDelta> _redo = [];
    public IReadOnlyList<string> LastChangedRootIds { get; private set; } = [];
    public string[] NodeOrder => _nodes.OfType<JsonObject>().Select(n => DocumentNodes.Id(n)!).ToArray();
    public JsonArray GetChangedNodes() => new(_nodes.OfType<JsonObject>().Where(n => LastChangedRootIds.Contains(DocumentNodes.Id(n)!)).Select(n => n.DeepClone()).ToArray());
    private readonly List<TextBinding> _bindings = [];
    private readonly Dictionary<string, Border> _rootBorders = [];
    private readonly Dictionary<string, ToggleButton> _blockSelectors = [];
    private readonly List<CellBinding> _cells = [];
    private bool _loading;
    private long _editVersion;
    public string? ProtectedHeadingId { get; set; }
    private bool _formatting;
    private bool _nativePaste;
    private string? _typingNode;
    private DateTime _typingAt;
    private string? _projectPath;
    private JsonObject? _styles;
    private string? _selectedRoot;
    private TextBinding? _active;
    private CellBinding? _activeCell;
    private CellBinding? _anchorCell;
    private readonly HashSet<string> _selectedCells = [];
    private readonly HashSet<string> _selectedBlocks = [];
    private string? _blockAnchor;
    private bool _blockSelectionMode;
    private bool _changingBlockSelection;
    private readonly List<(Image image, BitmapImage bitmap, string source, string root)> _mountedImages = [];
    private readonly HashSet<string> _failedImages = [];
    private static readonly SolidColorBrush TransparentBrush = new(Colors.Transparent);
    private static readonly SolidColorBrush InkBrush = new(Color.FromArgb(255, 36, 36, 36));
    private static readonly SolidColorBrush LineBrush = new(Color.FromArgb(255, 181, 187, 194));
    private static readonly SolidColorBrush SelectionBrush = new(Color.FromArgb(255, 0, 120, 212));

    private static Color BlockColor(string type) => type switch
    {
        "paragraph" => Color.FromArgb(255, 0, 120, 212),
        "heading" => Color.FromArgb(255, 115, 76, 180),
        "table" => Color.FromArgb(255, 39, 133, 74),
        "bulletList" => Color.FromArgb(255, 199, 99, 28),
        "orderedList" => Color.FromArgb(255, 137, 126, 24),
        "blockquote" => Color.FromArgb(255, 0, 137, 139),
        "codeBlock" => Color.FromArgb(255, 139, 87, 58),
        "image" => Color.FromArgb(255, 183, 65, 130),
        _ => Color.FromArgb(255, 100, 116, 139)
    };

    private sealed class TextBinding(JsonObject node, string root, RichEditBox editor, JsonObject? before, JsonObject? after)
    {
        public JsonObject Node = node;
        public string RootId = root;
        public RichEditBox Editor = editor;
        public JsonObject? Before = before;
        public JsonObject? After = after;
        public string Text = "";
        public string Font = "宋体";
        public double Size = 12;
        public bool BaseBold, BaseItalic;
        public bool Pending;
        public bool Composing;
    }
    private sealed class CellBinding(JsonObject table, NativeCell cell, string root, Border border)
    {
        public JsonObject Table = table;
        public NativeCell Cell = cell;
        public string RootId = root;
        public Border Border = border;
        public bool Lazy;
        public bool Editing;
    }

    public event EventHandler? NodesChanged;
    public event EventHandler? SelectionChanged;
    public event EventHandler? RequestImagePaste;
    public event EventHandler<NativeImageDropEventArgs>? ImageDropRequested;
    public event EventHandler<string>? Notice;
    public string? SelectedRootId => _selectedRoot;
    public string? SelectedNodeId => _active == null ? _selectedRoot : DocumentNodes.Id(_active.Node);
    public IReadOnlyList<string> SelectedCellIds => _selectedCells.ToArray();
    public string? EditingCellId => _cells.FirstOrDefault(c => c.Editing) is { } cell ? DocumentNodes.Id(cell.Cell.Node) : null;
    public IReadOnlyList<string> SelectedBlockIds => NodeOrder.Where(_selectedBlocks.Contains).ToArray();
    public bool IsComposing => _bindings.Any(b => b.Composing);
    public long RootComparisonCount { get; private set; }
    public int ActiveTextEditorCount => _bindings.Count;
    public int TableCellCount => _cells.Count;
    public int ImageCount => _mountedImages.Count;
    public int LoadedImageCount => _mountedImages.Count(item => item.bitmap.PixelWidth > 0 && item.bitmap.PixelHeight > 0);
    public IReadOnlyList<string> FailedImages => _failedImages.ToArray();
    public Func<byte[], string, Task<string>>? ImportImageAssetAsync { get; set; }
    public bool CanUndo => _undo.Count > 0;
    public bool CanRedo => _redo.Count > 0;
    public JsonArray FormattingSnapshots => new(_bindings.Select(b => (JsonNode)new JsonObject {
        ["nodeId"] = DocumentNodes.Id(b.Node), ["font"] = b.Editor.Document.GetRange(0, Math.Min(1, b.Text.Length)).CharacterFormat.Name,
        ["size"] = b.Editor.Document.GetDefaultCharacterFormat().Size, ["baseBold"] = b.BaseBold,
        ["alignment"] = b.Editor.Document.GetRange(0, 0).ParagraphFormat.Alignment.ToString(),
        ["lineRule"] = b.Editor.Document.GetRange(0, 0).ParagraphFormat.LineSpacingRule.ToString(), ["line"] = b.Editor.Document.GetRange(0, 0).ParagraphFormat.LineSpacing,
        ["before"] = b.Editor.Document.GetRange(0, 0).ParagraphFormat.SpaceBefore, ["after"] = b.Editor.Document.GetRange(0, 0).ParagraphFormat.SpaceAfter, ["firstLine"] = b.Editor.Document.GetRange(0, 0).ParagraphFormat.FirstLineIndent,
        ["selectionStart"] = b.Editor.Document.Selection.StartPosition, ["selectionEnd"] = b.Editor.Document.Selection.EndPosition
    }).ToArray());

    public NativeDocumentEditor()
    {
        Content = _surface;
        IsTabStop = false;
        PreviewKeyDown += OnDocumentKey;
        AllowDrop = true;
        DragOver += (_, e) =>
        {
            if (e.DataView.Contains(StandardDataFormats.StorageItems))
            {
                e.AcceptedOperation = DataPackageOperation.Copy;
                e.Handled = true;
            }
        };
        Drop += OnDrop;
    }

    public void FlushEdits() => FlushPending();

    public JsonArray GetNodes()
    {
        FlushPending();
        return (JsonArray)_nodes.DeepClone();
    }

    public void LoadNodes(JsonArray nodes, string? projectPath = null, JsonObject? styles = null, bool keepHistory = false, IReadOnlySet<string>? affectedIds = null)
    {
        var styleChanged = !JsonNode.DeepEquals(_styles, styles);
        _projectPath = projectPath;
        if (styleChanged) _styles = styles?.DeepClone().AsObject();
        var sameRoots = NodeOrder.SequenceEqual(nodes.OfType<JsonObject>().Select(DocumentNodes.Id));
        if (!sameRoots || _surface.Children.Count == 0)
        {
            var focus = CaptureFocus(requireActualFocus: true);
            _editVersion++; _nodes = nodes.DeepClone().AsArray();
            if (!keepHistory) { _undo.Clear(); _redo.Clear(); } ResetBaseline(); Render(focus); return;
        }
        var changed = new List<string>();
        for (int i = 0; i < nodes.Count; i++)
        {
            if (affectedIds != null && !affectedIds.Contains(DocumentNodes.Id(nodes[i]!.AsObject())!)) continue;
            RootComparisonCount++;
            if (JsonNode.DeepEquals(_nodes[i], nodes[i])) continue;
            var id = DocumentNodes.Id(nodes[i]!.AsObject())!;
            _editVersion++; _nodes[i] = nodes[i]!.DeepClone(); _committed[id] = _nodes[i]!.DeepClone().AsObject(); changed.Add(id);
        }
        if (changed.Count > 0)
        {
            // Remote changes invalidate only undo commands touching the same blocks.
            if (!keepHistory) { _undo.RemoveAll(d => d.Before.Keys.Intersect(changed).Any()); _redo.RemoveAll(d => d.Before.Keys.Intersect(changed).Any()); }
            RenderRoots(changed);
        }
        if (styleChanged) RefreshFormatting();
    }

    private void ResetBaseline()
    {
        _committed.Clear(); foreach (var n in _nodes.OfType<JsonObject>()) _committed[DocumentNodes.Id(n)!] = n.DeepClone().AsObject();
        _committedOrder = NodeOrder;
    }
    public void ResetHistory() { BreakTypingGroup(); _undo.Clear(); _redo.Clear(); ResetBaseline(); }
    public void RemapIds(IReadOnlyDictionary<string, string> mappings)
    {
        if (mappings.Count == 0) return;
        foreach (var node in _nodes.OfType<JsonObject>()) if (mappings.TryGetValue(DocumentNodes.Id(node)!, out var next)) DocumentNodes.Attributes(node)["id"] = next;
        foreach (var d in _undo.Concat(_redo)) d.Remap(mappings);
        if (_selectedRoot != null && mappings.TryGetValue(_selectedRoot, out var selected)) _selectedRoot = selected;
        if (_blockAnchor != null && mappings.TryGetValue(_blockAnchor, out var anchor)) _blockAnchor = anchor;
        var selectedBlocks = _selectedBlocks.Select(id => mappings.TryGetValue(id, out var mapped) ? mapped : id).ToArray();
        _selectedBlocks.Clear(); foreach (var id in selectedBlocks) _selectedBlocks.Add(id);
        ResetBaseline(); Render();
    }

    private void RenderRoots(IEnumerable<string> ids)
    {
        var focus = CaptureFocus(requireActualFocus: true); _loading = true;
        try
        {
            foreach (var id in ids)
            {
                if (!_rootBorders.TryGetValue(id, out var border)) continue;
                var node = _nodes.OfType<JsonObject>().FirstOrDefault(n => DocumentNodes.Id(n) == id); if (node == null) continue;
                _bindings.RemoveAll(b => b.RootId == id); _cells.RemoveAll(c => c.RootId == id); _mountedImages.RemoveAll(i => i.root == id);
                if (_active?.RootId == id) _active = null; if (_activeCell?.RootId == id) _activeCell = null;
                border.Child = RenderNode(node, id);
                border.Tag = DocumentNodes.Type(node);
            }
        }
        finally { _loading = false; }
        HighlightBlocks();
        if (focus is { } f && _bindings.FirstOrDefault(b => DocumentNodes.Id(b.Node) == f.id) is { } binding) FocusText(binding, f.start, f.end);
    }

    public void SelectRoot(string id)
    {
        if (!_rootBorders.ContainsKey(id)) return;
        ClearBlockSelection(); _blockAnchor = id;
        Select(id);
        var binding = _bindings.FirstOrDefault(b => b.RootId == id);
        if (binding != null) { _active = binding; FocusText(binding, 0, 0); }
        else _rootBorders[id].Focus(FocusState.Programmatic);
        _rootBorders[id].StartBringIntoView();
    }

    public void SelectRoots(IReadOnlyList<string> ids, string? currentId = null)
    {
        if (IsComposing) return;
        var selected = NodeOrder.Where(ids.Contains).ToArray();
        if (selected.Length == 0)
        {
            FlushPending(); BreakTypingGroup();
            _selectedRoot = null; _active = null; _blockAnchor = null;
            _activeCell = null; _anchorCell = null; _selectedCells.Clear();
            ClearBlockSelection(); SelectionChanged?.Invoke(this, EventArgs.Empty); return;
        }
        FlushPending(); BreakTypingGroup();
        _selectedBlocks.Clear();
        _blockSelectionMode = selected.Length > 1;
        if (_blockSelectionMode) foreach (var id in selected) _selectedBlocks.Add(id);
        var current = currentId != null && selected.Contains(currentId) ? currentId : selected[^1];
        _blockAnchor = current;
        _active = _bindings.FirstOrDefault(b => b.RootId == current);
        Select(current);
        if (_rootBorders.TryGetValue(current, out var border)) border.StartBringIntoView();
    }

    private void Select(string root)
    {
        _selectedRoot = root;
        if (_activeCell != null && _activeCell.RootId != root) { EndCellEditing(); ClearCellSelection(); }
        HighlightBlocks();
        SelectionChanged?.Invoke(this, EventArgs.Empty);
    }

    private (string id, int start, int end)? CaptureFocus(bool requireActualFocus = false)
    {
        if (requireActualFocus)
        {
            var owner = FocusedTextBinding();
            if (owner == null) return null;
            _active = owner;
        }
        if (_active == null || DocumentNodes.Id(_active.Node) is not string id) return null;
        var selection = _active.Editor.Document.Selection;
        return (id, selection.StartPosition, selection.EndPosition);
    }

    private TextBinding? FocusedTextBinding()
    {
        if (XamlRoot == null) return null;
        var focused = FocusManager.GetFocusedElement(XamlRoot) as DependencyObject;
        while (focused != null)
        {
            var owner = _bindings.FirstOrDefault(b => ReferenceEquals(b.Editor, focused));
            if (owner != null) return owner;
            focused = VisualTreeHelper.GetParent(focused);
        }
        return null;
    }

    private void Render((string id, int start, int end)? focus = null)
    {
        _loading = true;
        try
        {
            _bindings.Clear(); _cells.Clear(); _rootBorders.Clear(); _blockSelectors.Clear(); _active = null; _activeCell = null; _anchorCell = null; _selectedCells.Clear();
            _mountedImages.Clear(); _failedImages.Clear();
            _surface.Children.Clear();
            var surviving = _nodes.OfType<JsonObject>().Select(DocumentNodes.Id).ToHashSet();
            _selectedBlocks.RemoveWhere(id => !surviving.Contains(id));
            if (_selectedBlocks.Count == 0) _blockSelectionMode = false;
            if (_blockAnchor != null && !surviving.Contains(_blockAnchor)) _blockAnchor = null;
            // An empty section offers a native insertion caret without inventing a persisted block.
            var visible = _nodes.Count == 0 ? new[] { DocumentNodes.Paragraph() } : _nodes.OfType<JsonObject>();
            foreach (var node in visible)
            {
                var id = DocumentNodes.Id(node) ?? Guid.NewGuid().ToString();
                var border = new Border { Child = RenderNode(node, id), Tag = DocumentNodes.Type(node), BorderThickness = new Thickness(1), BorderBrush = new SolidColorBrush(BlockColor(DocumentNodes.Type(node))), Padding = new Thickness(1, 2, 1, 2), CornerRadius = new CornerRadius(2), HorizontalAlignment = HorizontalAlignment.Stretch };
                AutomationProperties.SetAutomationId(border, "Block_" + id);
                AutomationProperties.SetName(border, "内容块 " + DocumentNodes.Type(node));
                border.PointerPressed += (_, _) =>
                {
                    if (DocumentNodes.Type(node) != "table") EndCellEditing();
                    if (IsKeyDown(VirtualKey.Shift) && DocumentNodes.Type(node) != "table") SelectBlockRange(id);
                    else if (!IsKeyDown(VirtualKey.Shift)) { ClearBlockSelection(); _blockAnchor = id; }
                    Select(id);
                };
                var selector = new ToggleButton
                {
                    Content = new FontIcon { Glyph = "\uE762", FontSize = 14 },
                    Width = 26, Height = 28, MinWidth = 0, MinHeight = 0,
                    Padding = new Thickness(0), Margin = new Thickness(0, 6, 6, 0),
                    VerticalAlignment = VerticalAlignment.Top
                };
                AutomationProperties.SetAutomationId(selector, "BlockSelector_" + id);
                AutomationProperties.SetName(selector, "选择内容块 " + DocumentNodes.Type(node));
                ToolTipService.SetToolTip(selector, "选择整个内容块；再次点击取消，可逐个点击多选");
                selector.Click += (_, _) => ToggleBlockSelection(id);
                var row = new Grid();
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(32) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                Grid.SetColumn(border, 1); row.Children.Add(selector); row.Children.Add(border);
                _blockSelectors[id] = selector; _rootBorders[id] = border; _surface.Children.Add(row);
            }
        }
        finally { _loading = false; }
        if (_selectedRoot == null || !_rootBorders.ContainsKey(_selectedRoot)) _selectedRoot = _rootBorders.Keys.FirstOrDefault();
        if (_selectedRoot != null) Select(_selectedRoot);
        if (focus is { } f)
        {
            var binding = _bindings.FirstOrDefault(b => DocumentNodes.Id(b.Node) == f.id);
            if (binding != null)
            {
                _active = binding;
                FocusText(binding, f.start, f.end);
            }
            else if (_bindings.FirstOrDefault() is { } first) FocusText(first, 0, 0);
        }
    }

    private void FocusText(TextBinding binding, int start, int end)
    {
        void Restore()
        {
            if (!_bindings.Contains(binding)) return;
            var cell = CellFor(binding);
            if (cell != null && !cell.Editing) ActivateCell(cell, false);
            _active = binding;
            binding.Editor.Focus(FocusState.Programmatic);
            binding.Editor.Document.Selection.SetRange(Math.Clamp(start, 0, binding.Text.Length), Math.Clamp(end, 0, binding.Text.Length));
        }
        if (binding.Editor.IsLoaded) Restore();
        else
        {
            RoutedEventHandler? loaded = null;
            loaded = (_, _) => { binding.Editor.Loaded -= loaded; Restore(); };
            binding.Editor.Loaded += loaded;
        }
    }

    private FrameworkElement RenderNode(JsonObject node, string root)
    {
        switch (DocumentNodes.Type(node))
        {
            case "paragraph": case "heading": case "codeBlock": return RenderParagraph(node, root);
            case "table": return RenderTable(node, root);
            case "image": return RenderImage(node, root);
            case "horizontalRule": return new Border { Background = LineBrush, Height = 1, Margin = new Thickness(0, 12, 0, 12) };
            case "bulletList": case "orderedList": return RenderList(node, root);
            case "blockquote": return new Border { BorderBrush = LineBrush, BorderThickness = new Thickness(3, 0, 0, 0), Padding = new Thickness(16, 4, 0, 4), Child = RenderChildren(node, root) };
            default:
                if (DocumentNodes.Children(node).Any()) return RenderChildren(node, root);
                return new TextBlock { Text = "保留的内容类型：" + DocumentNodes.Type(node), TextWrapping = TextWrapping.Wrap, Foreground = new SolidColorBrush(Colors.Gray), Margin = new Thickness(4) };
        }
    }
    private StackPanel RenderChildren(JsonObject node, string root)
    {
        var panel = new StackPanel { Spacing = 3 };
        foreach (var child in DocumentNodes.Children(node)) panel.Children.Add(RenderNode(child, root));
        return panel;
    }
    private FrameworkElement RenderList(JsonObject node, string root)
    {
        var panel = new StackPanel { Spacing = 2, Margin = new Thickness(12, 0, 0, 0) };
        int number = (node["attrs"] as JsonObject)?["start"]?.GetValue<int>() ?? 1;
        foreach (var item in DocumentNodes.Children(node))
        {
            var row = new Grid(); row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(30) }); row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var marker = new TextBlock { Text = DocumentNodes.Type(node) == "orderedList" ? number++ + "." : "•", Margin = new Thickness(0, 9, 6, 0), HorizontalAlignment = HorizontalAlignment.Right };
            var content = RenderChildren(item, root); Grid.SetColumn(content, 1); row.Children.Add(marker); row.Children.Add(content); panel.Children.Add(row);
        }
        return panel;
    }

    private FrameworkElement RenderParagraph(JsonObject node, string root)
    {
        var panel = new StackPanel { Spacing = 2 };
        var children = DocumentNodes.Children(node).ToList(); JsonObject? previous = null;
        foreach (var special in children.Where(n => DocumentNodes.Type(n) is not ("text" or "hardBreak")))
        {
            panel.Children.Add(CreateTextEditor(node, root, previous, special));
            panel.Children.Add(RenderNode(special, root)); previous = special;
        }
        panel.Children.Add(CreateTextEditor(node, root, previous, null));
        if (DocumentNodes.Type(node) == "codeBlock") return new Border { Background = new SolidColorBrush(Color.FromArgb(255, 246, 247, 249)), Padding = new Thickness(8), Child = panel };
        return panel;
    }

    private RichEditBox CreateTextEditor(JsonObject node, string root, JsonObject? before, JsonObject? after)
    {
        var editor = new RichEditBox
        {
            AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 34,
            Padding = new Thickness(4, 3, 4, 3), BorderThickness = new Thickness(0), Background = TransparentBrush,
            Foreground = InkBrush, HorizontalAlignment = HorizontalAlignment.Stretch,
            IsSpellCheckEnabled = false, IsTextPredictionEnabled = false
        };
        ScrollViewer.SetHorizontalScrollBarVisibility(editor, ScrollBarVisibility.Disabled);
        ScrollViewer.SetVerticalScrollBarVisibility(editor, ScrollBarVisibility.Disabled);
        AutomationProperties.SetAutomationId(editor, "Text_" + DocumentNodes.Id(node) + (before == null ? "" : "_after_" + DocumentNodes.Id(before)));
        AutomationProperties.SetName(editor, DocumentNodes.Type(node) == "heading" ? "标题正文" : "段落正文");
        var binding = new TextBinding(node, root, editor, before, after); _bindings.Add(binding);
        Populate(binding);
        editor.GotFocus += (_, _) =>
        {
            _active = binding; Select(root);
            var cell = _cells.FirstOrDefault(c => DocumentNodes.Descendants(c.Cell.Node).Any(n => ReferenceEquals(n, node)));
            if (cell != null) SelectCell(cell, IsKeyDown(VirtualKey.Shift));
        };
        editor.SelectionChanged += (_, _) =>
        {
            // Programmatic ranges can deliver queued events after formatting or a render has finished.
            // Only a currently mounted editor that owns the actual keyboard focus may change the active node.
            if (!_loading && _bindings.Contains(binding) && ReferenceEquals(FocusedTextBinding(), binding))
            {
                _active = binding; Select(root);
            }
        };
        editor.TextChanged += (_, _) =>
        {
            if (_loading || binding.Composing) return;
            binding.Pending = true;
            if (ReadBinding(binding))
            {
                if (_blockSelectionMode && !_changingBlockSelection) ReplaceBlocksFromTyping(binding);
                else Commit(!_formatting, DocumentNodes.Id(binding.Node));
            }
        };
        editor.TextCompositionStarted += (_, _) => binding.Composing = true;
        editor.TextCompositionEnded += (_, _) =>
        {
            binding.Composing = false;
            if (_loading) return;
            binding.Pending = true;
            if (ReadBinding(binding))
            {
                if (_blockSelectionMode && !_changingBlockSelection) ReplaceBlocksFromTyping(binding);
                else Commit(true, DocumentNodes.Id(binding.Node));
            }
        };
        editor.PreviewKeyDown += (_, e) => OnTextKey(binding, e);
        editor.Paste += (_, e) =>
        {
            if (_nativePaste) return;
            try
            {
                var clipboard = Clipboard.GetContent();
                if (clipboard.Contains(DocumentClipboard.NodesFormat) || clipboard.Contains(StandardDataFormats.Text))
                {
                    e.Handled = true;
                    _ = PasteWithNoticeAsync(); return;
                }
                if (clipboard.Contains(StandardDataFormats.Bitmap) || clipboard.Contains(StandardDataFormats.StorageItems))
                {
                    e.Handled = true; RequestImagePaste?.Invoke(this, EventArgs.Empty);
                }
            }
            catch (Exception ex) { Notice?.Invoke(this, "读取剪贴板失败：" + ex.Message); }
        };
        return editor;
    }

    private (int start, int end) Bounds(TextBinding binding)
    {
        var content = DocumentNodes.Content(binding.Node);
        int start = binding.Before == null ? 0 : content.IndexOf(binding.Before) + 1;
        int end = binding.After == null ? content.Count : content.IndexOf(binding.After);
        return (Math.Clamp(start, 0, content.Count), Math.Clamp(end < 0 ? content.Count : end, start, content.Count));
    }
    private List<JsonObject> Segment(TextBinding binding)
    {
        var (start, end) = Bounds(binding);
        return DocumentNodes.Content(binding.Node).Skip(start).Take(end - start).OfType<JsonObject>().ToList();
    }
    private int InlinePosition(TextBinding binding, int caret)
    {
        var (start, _) = Bounds(binding);
        return DocumentNodes.Explode(DocumentNodes.Content(binding.Node).Take(start).OfType<JsonObject>()).Count + caret;
    }

    private ResolvedDocumentStyle EffectiveStyle(JsonObject node) => DocumentStyleRules.Resolve(_styles, node, DocumentNodes.Ancestor(_nodes, node, "table") is not null);
    private void Populate(TextBinding binding)
    {
        var style = EffectiveStyle(binding.Node); var font = style.EastAsia; var pt = style.Size; binding.Font = font; binding.Size = pt; binding.BaseBold = style.Bold; binding.BaseItalic = style.Italic;
        binding.Editor.FontFamily = new FontFamily(font); binding.Editor.FontSize = pt * 4 / 3;
        var doc = binding.Editor.Document;
        var defaultFormat = doc.GetDefaultCharacterFormat(); defaultFormat.Name = font; defaultFormat.Size = (float)pt;
        defaultFormat.Bold = style.Bold ? FormatEffect.On : FormatEffect.Off; defaultFormat.Italic = style.Italic ? FormatEffect.On : FormatEffect.Off; defaultFormat.Strikethrough = FormatEffect.Off; defaultFormat.Subscript = FormatEffect.Off; defaultFormat.Superscript = FormatEffect.Off; defaultFormat.Underline = UnderlineType.None;
        doc.SetDefaultCharacterFormat(defaultFormat);
        var segment = Segment(binding); binding.Text = DocumentNodes.AtomText(DocumentNodes.Explode(segment));
        doc.SetText(TextSetOptions.None, binding.Text);
        int offset = 0;
        foreach (var node in segment)
        {
            int length = DocumentNodes.Type(node) == "text" ? DocumentNodes.Text(node).Length : 1;
            var range = doc.GetRange(offset, offset + length); var fmt = range.CharacterFormat;
            fmt.Bold = style.Bold || DocumentNodes.HasMark(node, "bold") ? FormatEffect.On : FormatEffect.Off;
            fmt.Italic = style.Italic || DocumentNodes.HasMark(node, "italic") ? FormatEffect.On : FormatEffect.Off;
            fmt.Strikethrough = DocumentNodes.HasMark(node, "strike") ? FormatEffect.On : FormatEffect.Off;
            // RichEdit treats the two effects as mutually exclusive, including when one is switched off.
            fmt.Subscript = FormatEffect.Off; fmt.Superscript = FormatEffect.Off;
            if (DocumentNodes.HasMark(node, "subscript")) fmt.Subscript = FormatEffect.On;
            else if (DocumentNodes.HasMark(node, "superscript")) fmt.Superscript = FormatEffect.On;
            fmt.Underline = DocumentNodes.HasMark(node, "underline") ? UnderlineType.Single : UnderlineType.None;
            fmt.Name = DocumentNodes.HasMark(node, "code") ? "Consolas" : font;
            fmt.Size = (float)pt;
            if (!DocumentNodes.HasMark(node, "code") && DocumentNodes.Type(node) == "text" && style.Latin != font)
            {
                var text = DocumentNodes.Text(node); int start = 0;
                while (start < text.Length) {
                    var asian = DocumentStyleRules.IsEastAsian(text[start]); int end = start + 1;
                    while (end < text.Length && DocumentStyleRules.IsEastAsian(text[end]) == asian) end++;
                    doc.GetRange(offset + start, offset + end).CharacterFormat.Name = asian ? font : style.Latin; start = end;
                }
            }
            // Setting ITextRange.Link inserts a hidden HYPERLINK field and changes character offsets.
            // Keep the URL in semantic marks and render its decoration without creating native fields.
            if (DocumentNodes.HasMark(node, "link"))
            {
                fmt.Underline = UnderlineType.Single;
                fmt.ForegroundColor = Color.FromArgb(255, 0, 102, 184);
            }
            offset += length;
        }
        var all = doc.GetRange(0, Math.Max(0, binding.Text.Length));
        var paragraph = all.ParagraphFormat;
        paragraph.Alignment = style.Alignment switch { "center" => ParagraphAlignment.Center, "right" => ParagraphAlignment.Right, "both" or "justify" => ParagraphAlignment.Justify, _ => ParagraphAlignment.Left };
        paragraph.SpaceBefore = (float)style.Before; paragraph.SpaceAfter = (float)style.After;
        paragraph.SetIndents((float)style.FirstLine, (float)style.Left, (float)style.Right);
        paragraph.SetLineSpacing(style.LineRule switch { "exact" => LineSpacingRule.Exactly, "atLeast" => LineSpacingRule.AtLeast, _ => LineSpacingRule.Multiple }, (float)(style.Line / (style.LineRule == "auto" ? 240 : 20)));
        doc.Selection.SetRange(0, 0); binding.Pending = false;
    }

    private string NativeText(TextBinding binding)
    {
        binding.Editor.Document.GetText(TextGetOptions.NoHidden, out string text);
        // RichEdit's final end-of-paragraph belongs to the control, not the shared node.
        if (text.EndsWith('\r')) text = text[..^1];
        return text.Replace("\r\n", "\n").Replace('\r', '\n');
    }
    private bool ReadBinding(TextBinding binding, bool force = false)
    {
        if (_loading || binding.Composing || !binding.Pending && !force) return false;
        binding.Pending = false;
        string text = NativeText(binding);
        var source = Segment(binding); var atoms = DocumentNodes.Reconcile(source, text, DocumentNodes.Type(binding.Node) == "codeBlock");
        for (int i = 0; i < atoms.Count; i++)
        {
            var atom = atoms[i]; if (DocumentNodes.Type(atom) != "text") continue;
            var range = binding.Editor.Document.GetRange(i, i + 1); var fmt = range.CharacterFormat;
            DocumentNodes.SetMark(atom, "bold", DocumentStyleRules.InlineEmphasis(fmt.Bold == FormatEffect.On, binding.BaseBold, DocumentNodes.HasMark(atom, "bold")));
            DocumentNodes.SetMark(atom, "italic", DocumentStyleRules.InlineEmphasis(fmt.Italic == FormatEffect.On, binding.BaseItalic, DocumentNodes.HasMark(atom, "italic")));
            DocumentNodes.SetMark(atom, "strike", fmt.Strikethrough == FormatEffect.On);
            DocumentNodes.SetMark(atom, "subscript", fmt.Subscript == FormatEffect.On);
            DocumentNodes.SetMark(atom, "superscript", fmt.Superscript == FormatEffect.On);
            // Link decoration is presentation; it must not become an extra underline mark during typing.
            bool implicitLinkUnderline = DocumentNodes.HasMark(atom, "link") && !DocumentNodes.HasMark(atom, "underline");
            if (!implicitLinkUnderline) DocumentNodes.SetMark(atom, "underline", fmt.Underline is not (UnderlineType.None or UnderlineType.Undefined));
            if (!DocumentNodes.HasMark(atom, "link"))
            {
                try
                {
                    var link = range.Link?.Trim('"');
                    if (link != null && Uri.TryCreate(link, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https") DocumentNodes.SetMark(atom, "link", true, new JsonObject { ["href"] = link });
                }
                catch { }
            }
        }
        var rebuilt = DocumentNodes.Coalesce(atoms);
        var previous = new JsonArray(source.Select(n => n.DeepClone()).ToArray());
        binding.Text = text;
        if (JsonNode.DeepEquals(previous, rebuilt)) return false;
        var (start, end) = Bounds(binding); var content = DocumentNodes.Content(binding.Node);
        for (int i = end - 1; i >= start; i--) content.RemoveAt(i);
        for (int i = 0; i < rebuilt.Count; i++) content.Insert(start + i, rebuilt[i]?.DeepClone());
        if (_nodes.Count == 0 && rebuilt.Count > 0 && !_blockSelectionMode) { _nodes.Add(binding.Node); _selectedRoot = binding.RootId; }
        return true;
    }
    private void FlushPending()
    {
        if (_loading) return;
        string? changedNode = null; bool changed = false;
        foreach (var binding in _bindings)
            if (ReadBinding(binding)) { changed = true; changedNode = DocumentNodes.Id(binding.Node); }
        if (changed) Commit(!_formatting, changedNode);
    }
    private void RefreshFormatting()
    {
        var focus = CaptureFocus(); _loading = true;
        try { foreach (var binding in _bindings) Populate(binding); } finally { _loading = false; }
        if (focus is { } f && _bindings.FirstOrDefault(b => DocumentNodes.Id(b.Node) == f.id) is { } active)
        {
            active.Editor.Document.Selection.SetRange(Math.Clamp(f.start, 0, active.Text.Length), Math.Clamp(f.end, 0, active.Text.Length));
        }
    }

    private FrameworkElement RenderImage(JsonObject node, string root)
    {
        var panel = new StackPanel { Spacing = 3, Margin = new Thickness(4, 8, 4, 8) };
        var attrs = node["attrs"] as JsonObject;
        string src = attrs?["src"]?.GetValue<string>() ?? "";
        string alt = attrs?["alt"]?.GetValue<string>() ?? "图片";
        var image = new Image { Stretch = Stretch.Uniform, MaxHeight = 700, HorizontalAlignment = HorizontalAlignment.Center };
        var bitmap = new BitmapImage();
        _mountedImages.Add((image, bitmap, src, root));
        image.Source = bitmap;
        if (attrs?["width"] is JsonValue width && width.TryGetValue<double>(out var w) && w > 0) image.Width = w;
        AutomationProperties.SetAutomationId(image, "Image_" + DocumentNodes.Id(node)); AutomationProperties.SetName(image, alt);
        var missing = new TextBlock { Text = "无法显示图片：" + src + "（资源引用已保留）", TextWrapping = TextWrapping.Wrap, Foreground = new SolidColorBrush(Colors.DarkOrange), Visibility = Visibility.Collapsed };
        image.ImageFailed += (_, e) => ImageFailure(image, missing, src, e.ErrorMessage);
        if (_projectPath != null && src.StartsWith("assets/", StringComparison.Ordinal) && !src.Contains(".."))
        {
            try { _ = DecodeImageAsync(image, bitmap, missing, src, Path.GetFullPath(Path.Combine(_projectPath, src))); }
            catch (Exception ex) { ImageFailure(image, missing, src, ex.Message); }
        }
        else ImageFailure(image, missing, src, "项目图片路径无效。");
        image.PointerPressed += (_, _) => { _active = null; Select(root); };
        panel.Children.Add(image); panel.Children.Add(missing);
        if (!string.IsNullOrWhiteSpace(alt)) panel.Children.Add(new TextBlock { Text = alt, FontSize = 11, Foreground = new SolidColorBrush(Colors.Gray), HorizontalAlignment = HorizontalAlignment.Center });
        return panel;
    }

    private async Task DecodeImageAsync(Image image, BitmapImage bitmap, TextBlock missing, string src, string path)
    {
        try
        {
            var file = await StorageFile.GetFileFromPathAsync(path);
            using var stream = await file.OpenReadAsync();
            await bitmap.SetSourceAsync(stream);
            if (!_mountedImages.Any(item => ReferenceEquals(item.image, image))) return;
            if (bitmap.PixelWidth <= 0 || bitmap.PixelHeight <= 0) { ImageFailure(image, missing, src, "图片解码后没有有效尺寸。"); return; }
            _failedImages.Remove(src); missing.Visibility = Visibility.Collapsed; image.Visibility = Visibility.Visible;
        }
        catch (Exception ex) { ImageFailure(image, missing, src, ex.Message); }
    }

    private void ImageFailure(Image image, TextBlock missing, string src, string error)
    {
        if (!_mountedImages.Any(item => ReferenceEquals(item.image, image))) return;
        missing.Visibility = Visibility.Visible; image.Visibility = Visibility.Collapsed;
        if (_failedImages.Add(src)) Notice?.Invoke(this, "图片无法显示，资源引用已保留：" + src + (string.IsNullOrEmpty(error) ? "" : "；" + error));
    }

    private FrameworkElement RenderTable(JsonObject table, string root)
    {
        var layout = NativeTableModel.Layout(table); bool lazy = layout.Cells.Count > 100; var grid = new Grid { Margin = new Thickness(2, 8, 2, 8), HorizontalAlignment = HorizontalAlignment.Stretch };
        for (int r = 0; r < layout.Rows; r++) grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        for (int c = 0; c < layout.Columns; c++) grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star), MinWidth = 64 });
        foreach (var cell in layout.Cells)
        {
            var border = new Border { BorderBrush = LineBrush, BorderThickness = new Thickness(.5), Padding = new Thickness(3), Background = DocumentNodes.Type(cell.Node) == "tableHeader" ? new SolidColorBrush(Color.FromArgb(255, 242, 245, 248)) : TransparentBrush, Child = lazy ? ReadCell(cell.Node) : RenderChildren(cell.Node, root), MinHeight = 42 };
            Grid.SetRow(border, cell.Row); Grid.SetColumn(border, cell.Column); Grid.SetRowSpan(border, cell.RowSpan); Grid.SetColumnSpan(border, cell.ColumnSpan);
            AutomationProperties.SetAutomationId(border, "Cell_" + DocumentNodes.Id(cell.Node));
            AutomationProperties.SetName(border, $"表格第 {cell.Row + 1} 行第 {cell.Column + 1} 列");
            var binding = new CellBinding(table, cell, root, border) { Lazy = lazy }; _cells.Add(binding);
            SetCellEditing(binding, false);
            border.AddHandler(UIElement.PointerPressedEvent, new PointerEventHandler((_, e) =>
            {
                if (!e.GetCurrentPoint(border).Properties.IsLeftButtonPressed || IsComposing) return;
                bool shift = IsKeyDown(VirtualKey.Shift);
                if (binding.Editing && !shift) return;
                FlushPending(); EndCellEditing(); ClearBlockSelection(); _active = null; _blockAnchor = root;
                SelectCell(binding, shift); Select(root);
                if (_blockSelectors.TryGetValue(root, out var selector)) selector.Focus(FocusState.Programmatic);
                e.Handled = true;
            }), true);
            border.DoubleTapped += (_, e) =>
            {
                if (IsComposing || IsKeyDown(VirtualKey.Shift)) return;
                ClearBlockSelection(); Select(root); SelectCell(binding, false);
                ActivateCell(binding, true); e.Handled = true;
            };
            grid.Children.Add(border);
        }
        return grid;
    }
    private static FrameworkElement ReadCell(JsonObject cell) => new TextBlock
    {
        Text = string.Join("\n", DocumentNodes.Children(cell).Select(DocumentNodes.Text)),
        TextWrapping = TextWrapping.Wrap, Margin = new Thickness(4, 3, 4, 3), MinHeight = 34
    };
    private void ActivateCell(CellBinding cell, bool focus)
    {
        if (IsComposing) return;
        FlushPending(); EndCellEditing(cell);
        var existing = _bindings.FirstOrDefault(b => DocumentNodes.Descendants(cell.Cell.Node).Any(n => ReferenceEquals(n, b.Node)));
        if (existing != null) { SetCellEditing(cell, true); if (focus) FocusText(existing, 0, 0); return; }
        foreach (var other in _cells.Where(c => c.Lazy && !ReferenceEquals(c, cell)))
        {
            var descendants = DocumentNodes.Descendants(other.Cell.Node).ToHashSet();
            if (!_bindings.Any(b => descendants.Contains(b.Node))) continue;
            _bindings.RemoveAll(b => descendants.Contains(b.Node)); other.Border.Child = ReadCell(other.Cell.Node);
        }
        _loading = true;
        try { cell.Border.Child = RenderChildren(cell.Cell.Node, cell.RootId); }
        finally { _loading = false; }
        SetCellEditing(cell, true);
        var active = _bindings.FirstOrDefault(b => DocumentNodes.Descendants(cell.Cell.Node).Any(n => ReferenceEquals(n, b.Node)));
        if (active != null && focus) FocusText(active, 0, 0);
    }
    private CellBinding? CellFor(TextBinding binding) => _cells.FirstOrDefault(c =>
        DocumentNodes.Descendants(c.Cell.Node).Any(n => ReferenceEquals(n, binding.Node)));

    private void SetCellEditing(CellBinding cell, bool editing)
    {
        cell.Editing = editing;
        if (cell.Border.Child is UIElement content) content.IsHitTestVisible = editing;
        foreach (var binding in _bindings.Where(b => DocumentNodes.Descendants(cell.Cell.Node).Any(n => ReferenceEquals(n, b.Node))))
        {
            binding.Editor.IsReadOnly = !editing;
            binding.Editor.IsTabStop = editing;
        }
    }
    private void EndCellEditing(CellBinding? except = null)
    {
        foreach (var cell in _cells.Where(c => c.Editing && !ReferenceEquals(c, except)))
        {
            FlushPending(); SetCellEditing(cell, false);
            if (_active != null && ReferenceEquals(CellFor(_active), cell)) _active = null;
        }
    }
    private void ClearCellSelection()
    {
        _activeCell = null; _anchorCell = null; _selectedCells.Clear();
        foreach (var cell in _cells)
        {
            cell.Border.BorderBrush = LineBrush;
            cell.Border.BorderThickness = new Thickness(.5);
        }
    }
    private void SelectCell(CellBinding cell, bool extend)
    {
        if (!extend || _anchorCell == null || !ReferenceEquals(_anchorCell.Table, cell.Table)) { _anchorCell = cell; _selectedCells.Clear(); }
        _activeCell = cell;
        var anchor = _anchorCell!.Cell;
        int top = Math.Min(anchor.Row, cell.Cell.Row), left = Math.Min(anchor.Column, cell.Cell.Column);
        int bottom = Math.Max(anchor.Row + anchor.RowSpan - 1, cell.Cell.Row + cell.Cell.RowSpan - 1), right = Math.Max(anchor.Column + anchor.ColumnSpan - 1, cell.Cell.Column + cell.Cell.ColumnSpan - 1);
        _selectedCells.Clear();
        foreach (var binding in _cells)
        {
            bool selected = ReferenceEquals(binding.Table, cell.Table) && binding.Cell.Row <= bottom && binding.Cell.Row + binding.Cell.RowSpan > top && binding.Cell.Column <= right && binding.Cell.Column + binding.Cell.ColumnSpan > left;
            if (selected && DocumentNodes.Id(binding.Cell.Node) is string id) _selectedCells.Add(id);
            binding.Border.BorderBrush = selected ? SelectionBrush : LineBrush;
            binding.Border.BorderThickness = new Thickness(selected ? 1.5 : .5);
        }
        SelectionChanged?.Invoke(this, EventArgs.Empty);
    }

    private void BreakTypingGroup() { _typingNode = null; _typingAt = default; }
    private void Commit(bool typing = false, string? nodeId = null)
    {
        if (!typing) BreakTypingGroup();
        if (_loading) return;
        var root = nodeId == null ? null : _bindings.FirstOrDefault(b => DocumentNodes.Id(b.Node) == nodeId)?.RootId;
        var delta = BlockEditDelta.Capture(_committed, _committedOrder, _nodes, root);
        if (delta.IsEmpty) return;
        _editVersion++;
        var now = DateTime.UtcNow;
        bool continued = typing && nodeId != null && nodeId == _typingNode && (now - _typingAt).TotalMilliseconds < 500 && _undo.Count > 0 && delta.BeforeOrder == null && _undo[^1].BeforeOrder == null;
        if (continued)
        {
            var group = _undo[^1];
            foreach (var p in delta.Before) if (!group.Before.ContainsKey(p.Key)) group.Before[p.Key] = p.Value;
            foreach (var p in delta.After) group.After[p.Key] = p.Value;
        }
        else { _undo.Add(delta); if (_undo.Count > 200) _undo.RemoveAt(0); }
        foreach (var p in delta.After) { if (p.Value == null) _committed.Remove(p.Key); else _committed[p.Key] = p.Value.DeepClone().AsObject(); }
        _committedOrder = NodeOrder;
        if (typing) { _typingNode = nodeId; _typingAt = now; }
        _redo.Clear(); LastChangedRootIds = delta.After.Keys.ToArray(); NodesChanged?.Invoke(this, EventArgs.Empty);
    }
    public void Undo() => ApplyHistory(false);
    public void Redo() => ApplyHistory(true);
    private void ApplyHistory(bool redo)
    {
        FlushPending(); BreakTypingGroup(); var source = redo ? _redo : _undo; if (source.Count == 0) return;
        ClearBlockSelection(); var focus = CaptureFocus(); var delta = source[^1]; source.RemoveAt(source.Count - 1);
        _editVersion++; delta.Apply(_nodes, redo); (redo ? _undo : _redo).Add(delta);
        foreach (var p in redo ? delta.After : delta.Before) { if (p.Value == null) _committed.Remove(p.Key); else _committed[p.Key] = p.Value.DeepClone().AsObject(); }
        _committedOrder = NodeOrder;
        LastChangedRootIds = delta.Before.Keys.ToArray();
        if (delta.BeforeOrder != null) Render(focus); else RenderRoots(LastChangedRootIds);
        NodesChanged?.Invoke(this, EventArgs.Empty);
    }
    private void Mutate(Action change, (string id, int start, int end)? focus = null)
    {
        FlushPending(); BreakTypingGroup(); change(); Commit(); Render(focus);
    }
    private JsonObject? SelectedRoot() => _nodes.OfType<JsonObject>().FirstOrDefault(n => DocumentNodes.Id(n) == _selectedRoot);
    private List<JsonObject> SelectedBlocks() => _nodes.OfType<JsonObject>().Where(n => _selectedBlocks.Contains(DocumentNodes.Id(n)!)).ToList();
    private void ClearBlockSelection()
    {
        _selectedBlocks.Clear(); _blockSelectionMode = false; HighlightBlocks();
    }
    private void HighlightBlocks()
    {
        foreach (var pair in _rootBorders)
        {
            bool selected = _blockSelectionMode && _selectedBlocks.Contains(pair.Key);
            bool active = selected || pair.Key == _selectedRoot;
            var color = BlockColor(pair.Value.Tag as string ?? "paragraph");
            pair.Value.Background = selected ? new SolidColorBrush(Color.FromArgb(22, color.R, color.G, color.B)) : TransparentBrush;
            pair.Value.BorderBrush = new SolidColorBrush(Color.FromArgb(active ? (byte)255 : (byte)140, color.R, color.G, color.B));
            pair.Value.BorderThickness = new Thickness(active ? 2 : 1);
            // Keep the content inset constant when the selection outline becomes thicker.
            pair.Value.Padding = active ? new Thickness(0, 1, 0, 1) : new Thickness(1, 2, 1, 2);
            if (_blockSelectors.TryGetValue(pair.Key, out var selector)) selector.IsChecked = selected;
        }
    }
    private void ToggleBlockSelection(string id)
    {
        if (IsComposing || !NodeOrder.Contains(id)) { HighlightBlocks(); return; }
        FlushPending(); BreakTypingGroup(); EndCellEditing(); ClearCellSelection(); _active = null;
        if (!_selectedBlocks.Add(id)) _selectedBlocks.Remove(id);
        _blockSelectionMode = _selectedBlocks.Count > 0;
        _selectedRoot = _selectedBlocks.Contains(id) ? id : NodeOrder.LastOrDefault(_selectedBlocks.Contains);
        _blockAnchor = _selectedRoot;
        HighlightBlocks(); SelectionChanged?.Invoke(this, EventArgs.Empty);
    }
    public void SelectAllBlocks()
    {
        if (IsComposing) return;
        FlushPending(); BreakTypingGroup();
        _selectedBlocks.Clear(); foreach (var node in _nodes.OfType<JsonObject>()) if (DocumentNodes.Id(node) is string id) _selectedBlocks.Add(id);
        _blockSelectionMode = true; _blockAnchor = _nodes.OfType<JsonObject>().Select(DocumentNodes.Id).FirstOrDefault();
        HighlightBlocks(); SelectFirstSelectedText(); SelectionChanged?.Invoke(this, EventArgs.Empty);
    }
    private void SelectBlockRange(string id)
    {
        if (IsComposing) return;
        var ids = _nodes.OfType<JsonObject>().Select(DocumentNodes.Id).ToList();
        int anchor = ids.IndexOf(_blockAnchor ?? _selectedRoot), end = ids.IndexOf(id); if (end < 0) return;
        if (anchor < 0) anchor = end;
        _selectedBlocks.Clear(); for (int i = Math.Min(anchor, end); i <= Math.Max(anchor, end); i++) if (ids[i] != null) _selectedBlocks.Add(ids[i]!);
        _blockSelectionMode = true; HighlightBlocks();
        // Deferring keeps the clicked RichEditBox's native pointer handler from overwriting the whole-block selection.
        DispatcherQueue.TryEnqueue(() => { if (_blockSelectionMode) SelectFirstSelectedText(); });
    }
    private void SelectFirstSelectedText()
    {
        _changingBlockSelection = true;
        try
        {
            var binding = _bindings.FirstOrDefault(b => b.RootId == _selectedRoot && _selectedBlocks.Contains(b.RootId))
                ?? _bindings.FirstOrDefault(b => _selectedBlocks.Contains(b.RootId)) ?? (_nodes.Count == 0 ? _bindings.FirstOrDefault() : null);
            if (binding == null) return;
            _active = binding; binding.Editor.Focus(FocusState.Programmatic); binding.Editor.Document.Selection.SetRange(0, binding.Text.Length);
        }
        finally { _changingBlockSelection = false; }
    }
    private void ReplaceSelectedBlocks(IReadOnlyList<JsonObject> replacements, bool commit = true)
    {
        var selected = SelectedBlocks().Where(n => DocumentNodes.Id(n) != ProtectedHeadingId).ToList(); int insert = selected.Count == 0 ? Math.Min(1, _nodes.Count) : selected.Min(n => _nodes.IndexOf(n));
        foreach (var node in selected) _nodes.Remove(node);
        for (int i = 0; i < replacements.Count; i++) _nodes.Insert(insert + i, replacements[i]);
        ClearBlockSelection();
        _selectedRoot = replacements.Count > 0 ? DocumentNodes.Id(replacements[0]) : _nodes.OfType<JsonObject>().Select(DocumentNodes.Id).FirstOrDefault();
        if (commit) Commit();
    }
    private void ReplaceBlocksFromTyping(TextBinding binding)
    {
        var paragraph = (JsonObject)binding.Node.DeepClone(); if (DocumentNodes.Id(paragraph) == ProtectedHeadingId) DocumentNodes.Attributes(paragraph)["id"] = Guid.NewGuid().ToString(); paragraph["type"] = "paragraph"; DocumentNodes.Attributes(paragraph).Remove("level");
        int caret = binding.Editor.Document.Selection.StartPosition;
        ReplaceSelectedBlocks([paragraph], false); Commit(true, DocumentNodes.Id(paragraph)); Render((DocumentNodes.Id(paragraph)!, caret, caret));
    }
    private void RemoveSelectedBlocks()
    {
        if (IsComposing) return;
        FlushPending(); ReplaceSelectedBlocks([]); Render();
        if (_bindings.FirstOrDefault() is { } first) FocusText(first, 0, 0);
    }

    public async Task CopySelectionToClipboardAsync()
    {
        FlushPending(); BreakTypingGroup();
        var selection = FocusedTextBinding()?.Editor.Document.Selection;
        if (!_blockSelectionMode && selection != null && selection.StartPosition != selection.EndPosition)
        { selection.Copy(); return; }
        await CopySelectedBlocksToClipboardAsync();
    }
    public async Task CopySelectedBlocksToClipboardAsync()
    {
        if (IsComposing) return;
        FlushPending(); BreakTypingGroup();
        var originals = _blockSelectionMode ? SelectedBlocks() : SelectedRoot() is { } root ? new List<JsonObject> { root } : [];
        if (originals.Count == 0) return;
        var nodes = new JsonArray(originals.Select(n => n.DeepClone()).ToArray());
        var images = new JsonObject(); var project = _projectPath;
        foreach (var image in nodes.OfType<JsonObject>().SelectMany(DocumentNodes.Descendants).Where(n => DocumentNodes.Type(n) == "image"))
        {
            string src = image["attrs"]?["src"]?.GetValue<string>() ?? "";
            if (images.ContainsKey(src)) continue;
            if (project == null || !System.Text.RegularExpressions.Regex.IsMatch(src, @"^assets/[\w.-]+$")) throw new InvalidOperationException("剪贴板图片引用无效，复制已取消。");
            string assetRoot = Path.GetFullPath(Path.Combine(project, "assets")) + Path.DirectorySeparatorChar;
            string file = Path.GetFullPath(Path.Combine(project, src));
            if (!file.StartsWith(assetRoot, StringComparison.OrdinalIgnoreCase) || !File.Exists(file)) throw new FileNotFoundException("图片资源缺失，复制已取消：" + src);
            images[src] = new JsonObject { ["name"] = Path.GetFileName(file), ["base64"] = Convert.ToBase64String(await File.ReadAllBytesAsync(file)) };
        }
        if (project != _projectPath) throw new InvalidOperationException("项目已切换，请重新复制。");
        var payload = new JsonObject { ["formatVersion"] = 1, ["sourceProject"] = project, ["nodes"] = nodes.DeepClone(), ["images"] = images };
        // Custom clipboard data is persisted as a stream across Clipboard.Flush and application boundaries.
        using var stream = new InMemoryRandomAccessStream();
        using (var writer = new DataWriter(stream))
        {
            writer.WriteBytes(System.Text.Encoding.UTF8.GetBytes(payload.ToJsonString()));
            await writer.StoreAsync(); writer.DetachStream();
        }
        stream.Seek(0);
        var package = new DataPackage { RequestedOperation = DataPackageOperation.Copy };
        package.SetData(DocumentClipboard.NodesFormat, stream);
        package.SetText(string.Join("\n", nodes.OfType<JsonObject>().Select(DocumentClipboard.Plain)));
        package.SetHtmlFormat(HtmlFormatHelper.CreateHtmlFormat(string.Concat(nodes.OfType<JsonObject>().Select(n => DocumentClipboard.Html(n, project)))));
        Clipboard.SetContent(package); Clipboard.Flush();
    }
    public async Task CutSelectionToClipboardAsync()
    {
        if (IsComposing) return;
        if (!_blockSelectionMode) { _active?.Editor.Document.Selection.Cut(); return; }
        var before = _editVersion; var selected = _selectedBlocks.ToHashSet();
        await CopySelectionToClipboardAsync();
        if (_editVersion != before || !selected.SetEquals(_selectedBlocks)) throw new InvalidOperationException("选择已变化，剪切已取消。");
        RemoveSelectedBlocks();
    }
    public async Task PasteClipboardAsync()
    {
        if (IsComposing) return;
        var clipboard = Clipboard.GetContent();
        FlushPending();
        if (!clipboard.Contains(DocumentClipboard.NodesFormat) && clipboard.Contains(StandardDataFormats.Text)
            && SelectedRoot() is { } textTarget && !DocumentClipboard.IsEmptyTextBlock(textTarget))
        {
            PasteTextIntoSelection(); return;
        }
        var before = _editVersion; var project = _projectPath;
        var selected = _selectedBlocks.ToHashSet(); var target = _selectedRoot; bool blockSelection = _blockSelectionMode;
        void EnsurePasteContext()
        {
            if (IsComposing || project != _projectPath || before != _editVersion || target != _selectedRoot || blockSelection != _blockSelectionMode || !selected.SetEquals(_selectedBlocks))
                throw new InvalidOperationException("正文或选择已变化，请再次粘贴；当前正文已保留。");
        }
        List<JsonObject> incoming;
        if (clipboard.Contains(DocumentClipboard.NodesFormat))
        {
            var raw = await ReadClipboardNodesAsync(clipboard);
            EnsurePasteContext();
            var payload = JsonNode.Parse(raw)?.AsObject() ?? throw new InvalidOperationException("剪贴板节点数据无效。");
            if (payload["nodes"] is not JsonArray pasted || pasted.Any(n => n is not JsonObject)) throw new InvalidOperationException("剪贴板节点数据无效。");
            incoming = pasted.OfType<JsonObject>().Select(DocumentNodes.FreshCopy).ToList();
            var assetMap = new Dictionary<string, string>();
            foreach (var image in incoming.SelectMany(DocumentNodes.Descendants).Where(n => DocumentNodes.Type(n) == "image"))
            {
                string src = image["attrs"]?["src"]?.GetValue<string>() ?? "";
                if (assetMap.TryGetValue(src, out var imported)) { DocumentNodes.Attributes(image)["src"] = imported; continue; }
                if (project == null || !System.Text.RegularExpressions.Regex.IsMatch(src, @"^assets/[\w.-]+$")) throw new InvalidOperationException("剪贴板图片引用无效，粘贴已取消。");
                // The external sourceProject is used only for equality. Never read paths supplied by clipboard data.
                if (payload["sourceProject"]?.GetValue<string>() == project && File.Exists(Path.Combine(project, src))) imported = src;
                else
                {
                    if (ImportImageAssetAsync == null || payload["images"]?[src] is not JsonObject data || data["base64"]?.GetValue<string>() is not string encoded) throw new InvalidOperationException("剪贴板图片资源缺失或导入服务未就绪，粘贴已取消。");
                    var bytes = Convert.FromBase64String(encoded); string name = Path.GetFileName(data["name"]?.GetValue<string>() ?? "image.png");
                    EnsurePasteContext();
                    imported = await ImportImageAssetAsync(bytes, name);
                    EnsurePasteContext();
                    if (!System.Text.RegularExpressions.Regex.IsMatch(imported, @"^assets/[\w.-]+$")) throw new InvalidOperationException("图片导入服务未返回有效项目资源，粘贴已取消。");
                }
                assetMap[src] = imported; DocumentNodes.Attributes(image)["src"] = imported;
            }
        }
        else if (clipboard.Contains(StandardDataFormats.Text)) incoming = DocumentClipboard.FromText(await clipboard.GetTextAsync()).OfType<JsonObject>().ToList();
        else
        {
            if (clipboard.Contains(StandardDataFormats.Bitmap) || clipboard.Contains(StandardDataFormats.StorageItems)) RequestImagePaste?.Invoke(this, EventArgs.Empty);
            return;
        }
        if (incoming.Count == 0) return;
        FlushPending();
        EnsurePasteContext();
        InsertPastedBlocks(incoming, fillEmptyTextBlock: !clipboard.Contains(DocumentClipboard.NodesFormat));
        Render();
        if (_bindings.LastOrDefault(b => b.RootId == _selectedRoot) is { } lastBinding)
            FocusText(lastBinding, lastBinding.Text.Length, lastBinding.Text.Length);
        else if (_selectedRoot != null && _rootBorders.TryGetValue(_selectedRoot, out var border))
        { border.IsTabStop = true; border.Focus(FocusState.Programmatic); }
    }
    private void PasteTextIntoSelection()
    {
        FlushPending(); BreakTypingGroup();
        var binding = _active != null && _bindings.Contains(_active) && _active.RootId == _selectedRoot ? _active : null;
        if (binding == null && SelectedRoot() is { } root && DocumentNodes.Type(root) is "paragraph" or "heading" or "codeBlock")
            binding = _bindings.FirstOrDefault(b => b.RootId == _selectedRoot);
        if (binding == null || _activeCell is { Editing: false })
        { Notice?.Invoke(this, "请先进入段落或单元格编辑，再粘贴文字。"); return; }
        ClearBlockSelection();
        _nativePaste = true; _loading = true;
        try { binding.Editor.Document.Selection.Paste(0); }
        finally { _loading = false; _nativePaste = false; }
        binding.Pending = true;
        if (ReadBinding(binding, true)) Commit(nodeId: DocumentNodes.Id(binding.Node));
        var selection = binding.Editor.Document.Selection;
        FocusText(binding, selection.StartPosition, selection.EndPosition);
        SelectionChanged?.Invoke(this, EventArgs.Empty);
    }
    private void InsertPastedBlocks(IReadOnlyList<JsonObject> incoming, bool fillEmptyTextBlock = false)
    {
        BreakTypingGroup();
        var target = SelectedRoot();
        var last = fillEmptyTextBlock && DocumentClipboard.IsEmptyTextBlock(target)
            ? DocumentClipboard.FillEmptyTextBlock(_nodes, target!, incoming)
            : DocumentClipboard.InsertAfterSelected(_nodes, incoming, _selectedRoot);
        if (last == null) return;
        ClearBlockSelection(); _selectedRoot = last; _blockAnchor = last;
        Commit();
    }
    private static async Task<string> ReadClipboardNodesAsync(DataPackageView clipboard)
    {
        var raw = await clipboard.GetDataAsync(DocumentClipboard.NodesFormat);
        if (raw is string text) return text;
        using var stream = raw switch
        {
            IRandomAccessStream data => data,
            IRandomAccessStreamReference reference => await reference.OpenReadAsync(),
            _ => throw new InvalidOperationException("剪贴板节点数据无效。")
        };
        using var reader = new DataReader(stream.GetInputStreamAt(0));
        var loaded = await reader.LoadAsync(checked((uint)stream.Size));
        var bytes = new byte[checked((int)loaded)]; reader.ReadBytes(bytes);
        // Also accept UTF-16 streams produced by earlier copies of the application.
        var encoding = bytes.Length >= 2 && bytes[1] == 0 ? System.Text.Encoding.Unicode
            : bytes.Length >= 2 && bytes[0] == 0 ? System.Text.Encoding.BigEndianUnicode : System.Text.Encoding.UTF8;
        using var decoded = new StreamReader(new MemoryStream(bytes), encoding, detectEncodingFromByteOrderMarks: true);
        return decoded.ReadToEnd().TrimEnd('\0');
    }
    private async Task PasteWithNoticeAsync()
    {
        try { await PasteClipboardAsync(); } catch (Exception ex) { Notice?.Invoke(this, ex.Message); }
    }
    private async void OnDocumentKey(object sender, KeyRoutedEventArgs e)
    {
        if (e.Handled || IsComposing) return;
        bool ctrl = IsKeyDown(VirtualKey.Control);
        try
        {
            if (!_blockSelectionMode && _activeCell is { Editing: false } cell && !ctrl && e.Key is VirtualKey.Enter or VirtualKey.F2)
            { e.Handled = true; ActivateCell(cell, true); return; }
            if (!_blockSelectionMode && _activeCell is { Editing: true } editingCell && e.Key == VirtualKey.Escape)
            {
                e.Handled = true; EndCellEditing();
                if (_blockSelectors.TryGetValue(editingCell.RootId, out var selector)) selector.Focus(FocusState.Programmatic);
                SelectionChanged?.Invoke(this, EventArgs.Empty); return;
            }
            if (ctrl && e.Key == VirtualKey.A) { e.Handled = true; SelectAllBlocks(); return; }
            if (ctrl && (e.Key is VirtualKey.C or VirtualKey.V || _blockSelectionMode && e.Key == VirtualKey.X))
            {
                e.Handled = true;
                if (e.Key == VirtualKey.C) await CopySelectionToClipboardAsync();
                else if (e.Key == VirtualKey.X) await CutSelectionToClipboardAsync();
                else await PasteClipboardAsync(); return;
            }
            if (ctrl && _blockSelectionMode && e.Key == VirtualKey.Z && (IsKeyDown(VirtualKey.Shift) ? CanRedo : CanUndo))
            { e.Handled = true; if (IsKeyDown(VirtualKey.Shift)) Redo(); else Undo(); return; }
            if (ctrl && _blockSelectionMode && e.Key == VirtualKey.Y && CanRedo)
            { e.Handled = true; Redo(); return; }
            if (!ctrl && _blockSelectionMode && e.Key is VirtualKey.Back or VirtualKey.Delete)
            { e.Handled = true; RemoveSelectedBlocks(); return; }
            if (!ctrl && _blockSelectionMode && e.Key == VirtualKey.Enter)
            {
                e.Handled = true; var paragraph = DocumentNodes.Paragraph(); ReplaceSelectedBlocks([paragraph]); Render((DocumentNodes.Id(paragraph)!, 0, 0)); return;
            }
            if (_blockSelectionMode && e.Key is VirtualKey.Escape or VirtualKey.Left or VirtualKey.Right or VirtualKey.Up or VirtualKey.Down or VirtualKey.Home or VirtualKey.End)
            {
                ClearBlockSelection();
                if (e.Key == VirtualKey.Escape && _active != null)
                {
                    int caret = _active.Editor.Document.Selection.EndPosition; _active.Editor.Document.Selection.SetRange(caret, caret); e.Handled = true;
                }
                SelectionChanged?.Invoke(this, EventArgs.Empty);
            }
        }
        catch (Exception ex) { Notice?.Invoke(this, ex.Message); }
    }
    public void DeleteSelected()
    {
        if (_blockSelectionMode) { RemoveSelectedBlocks(); return; }
        var selected = SelectedRoot(); if (selected == null) return;
        if (DocumentNodes.Id(selected) == ProtectedHeadingId) { Notice?.Invoke(this, "请使用章节组织功能删除章节标题。"); return; }
        int index = _nodes.IndexOf(selected);
        Mutate(() =>
        {
            _nodes.RemoveAt(index); if (_nodes.Count == 0) _nodes.Add(DocumentNodes.Paragraph());
            _selectedRoot = DocumentNodes.Id((JsonObject)_nodes[Math.Min(index, _nodes.Count - 1)]!);
        });
    }
    public void MoveSelected(int offset)
    {
        var selected = SelectedRoot(); if (selected == null || DocumentNodes.Id(selected) == ProtectedHeadingId) return;
        int index = _nodes.IndexOf(selected), target = Math.Clamp(index + offset, ProtectedHeadingId == null ? 0 : 1, _nodes.Count - 1); if (index == target) return;
        Mutate(() => { _nodes.RemoveAt(index); _nodes.Insert(target, selected); }, CaptureFocus());
    }
    public void InsertParagraphAfterSelection()
    {
        var next = DocumentNodes.Paragraph(); int index = SelectedRoot() is { } selected ? _nodes.IndexOf(selected) + 1 : _nodes.Count;
        Mutate(() => { _nodes.Insert(index, next); _selectedRoot = DocumentNodes.Id(next); }, (DocumentNodes.Id(next)!, 0, 0));
    }
    public void InsertImage(JsonObject imageNode)
    {
        var image = (JsonObject)imageNode.DeepClone(); DocumentNodes.AssignIds(image);
        if (_blockSelectionMode) { ReplaceSelectedBlocks([image]); Render(); return; }
        // Images are independent block entities.
        int index = SelectedRoot() is { } selected ? _nodes.IndexOf(selected) + 1 : _nodes.Count;
        Mutate(() => { _nodes.Insert(index, image); _selectedRoot = DocumentNodes.Id(image); });
    }

    public void Execute(string command)
    {
        FlushPending();
        switch (command)
        {
            case "undo": Undo(); return; case "redo": Redo(); return;
            case "bold": case "italic": case "underline": case "strike": case "subscript": case "superscript": FormatText(command); return;
            case "paragraph": case "heading": SetParagraphType(command); return;
            case "bulletList": case "orderedList": ToggleList(command); return;
            case "splitBlock": if (_active != null) SplitBlock(_active); else InsertParagraphAfterSelection(); return;
            case "joinBlock": if (_active != null) JoinBlock(_active); return;
            case "table":
                var table = NativeTableModel.Create(); int index = SelectedRoot() is { } selected ? _nodes.IndexOf(selected) + 1 : _nodes.Count;
                Mutate(() => { _nodes.Insert(index, table); _selectedRoot = DocumentNodes.Id(table); }); return;
            case "addRowAfter": case "deleteRow": case "addColumnAfter": case "deleteColumn": case "mergeCells": case "splitCell": TableCommand(command); return;
            default: Notice?.Invoke(this, "当前选择无法执行该操作。"); return;
        }
    }
    private TextBinding? ActiveText()
    {
        _active ??= _bindings.FirstOrDefault(b => b.RootId == _selectedRoot);
        if (_active != null) _active.Editor.Focus(FocusState.Programmatic);
        return _active;
    }
    private void FormatText(string command)
    {
        if (_blockSelectionMode)
        {
            var text = SelectedBlocks().SelectMany(EditableTextNodes).ToList(); if (text.Count == 0) return;
            bool enabled = text.Any(n => !DocumentNodes.HasMark(n, command)); var focus = CaptureFocus();
            foreach (var node in text) DocumentNodes.SetMark(node, command, enabled);
            Commit(); Render(focus); return;
        }
        var binding = ActiveText(); if (binding == null) return;
        if (DocumentNodes.Type(binding.Node) == "codeBlock") { Notice?.Invoke(this, "代码块使用等宽纯文本格式。"); return; }
        BreakTypingGroup(); _formatting = true;
        var format = binding.Editor.Document.Selection.CharacterFormat;
        try
        {
            switch (command)
            {
                case "bold": format.Bold = format.Bold == FormatEffect.On ? FormatEffect.Off : FormatEffect.On; break;
                case "italic": format.Italic = format.Italic == FormatEffect.On ? FormatEffect.Off : FormatEffect.On; break;
                case "strike": format.Strikethrough = format.Strikethrough == FormatEffect.On ? FormatEffect.Off : FormatEffect.On; break;
                case "subscript": format.Subscript = format.Subscript == FormatEffect.On ? FormatEffect.Off : FormatEffect.On; break;
                case "superscript": format.Superscript = format.Superscript == FormatEffect.On ? FormatEffect.Off : FormatEffect.On; break;
                case "underline": format.Underline = format.Underline == UnderlineType.None ? UnderlineType.Single : UnderlineType.None; break;
            }
            binding.Pending = true; if (ReadBinding(binding, true)) Commit();
            if (command == "bold" && binding.BaseBold || command == "italic" && binding.BaseItalic) RefreshFormatting();
        }
        finally { _formatting = false; }
    }
    private static IEnumerable<JsonObject> EditableTextNodes(JsonObject node)
    {
        if (DocumentNodes.Type(node) == "codeBlock") yield break;
        if (DocumentNodes.Type(node) == "text") { yield return node; yield break; }
        foreach (var child in DocumentNodes.Children(node)) foreach (var text in EditableTextNodes(child)) yield return text;
    }
    private void SetParagraphType(string type)
    {
        var binding = ActiveText(); if (binding == null) return; var focus = CaptureFocus();
        if (DocumentNodes.Id(binding.Node) == ProtectedHeadingId && type != "heading") { Notice?.Invoke(this, "章节标题必须保持标题类型。"); return; }
        Mutate(() => { binding.Node["type"] = type; if (type == "heading") DocumentNodes.Attributes(binding.Node)["level"] = 2; else DocumentNodes.Attributes(binding.Node).Remove("level"); }, focus);
    }
    private void ToggleList(string type)
    {
        var binding = ActiveText(); if (binding == null) return;
        var list = DocumentNodes.Ancestor(_nodes, binding.Node, "bulletList") ?? DocumentNodes.Ancestor(_nodes, binding.Node, "orderedList");
        var focus = CaptureFocus();
        Mutate(() =>
        {
            if (list != null)
            {
                if (DocumentNodes.Type(list) != type) list["type"] = type;
                else if (DocumentNodes.Locate(_nodes, list) is { } place)
                {
                    var children = DocumentNodes.Children(list).SelectMany(DocumentNodes.Children).Select(n => n.DeepClone()).ToList();
                    place.parent.RemoveAt(place.index); for (int i = 0; i < children.Count; i++) place.parent.Insert(place.index + i, children[i]);
                }
            }
            else if (DocumentNodes.Locate(_nodes, binding.Node) is { } place)
            {
                var paragraph = binding.Node.DeepClone();
                var item = new JsonObject { ["type"] = "listItem", ["attrs"] = new JsonObject { ["id"] = Guid.NewGuid().ToString() }, ["content"] = new JsonArray(paragraph) };
                var wrapper = new JsonObject { ["type"] = type, ["attrs"] = new JsonObject { ["id"] = Guid.NewGuid().ToString(), ["start"] = 1 }, ["content"] = new JsonArray(item) };
                place.parent[place.index] = wrapper; if (ReferenceEquals(place.parent, _nodes)) _selectedRoot = DocumentNodes.Id(wrapper);
            }
        }, focus);
    }

    private static bool IsKeyDown(VirtualKey key) => (InputKeyboardSource.GetKeyStateForCurrentThread(key) & CoreVirtualKeyStates.Down) != 0;
    private void OnTextKey(TextBinding binding, KeyRoutedEventArgs e)
    {
        if (_loading || binding.Composing) return;
        _active = binding;
        bool ctrl = IsKeyDown(VirtualKey.Control), shift = IsKeyDown(VirtualKey.Shift);
        if (ctrl && e.Key == VirtualKey.Z) { if (shift ? CanRedo : CanUndo) { e.Handled = true; if (shift) Redo(); else Undo(); } return; }
        if (ctrl && e.Key == VirtualKey.Y) { if (CanRedo) { e.Handled = true; Redo(); } return; }
        if (ctrl && e.Key is VirtualKey.B or VirtualKey.I or VirtualKey.U) { e.Handled = true; FormatText(e.Key == VirtualKey.B ? "bold" : e.Key == VirtualKey.I ? "italic" : "underline"); return; }
        if (e.Key == VirtualKey.Enter && !shift && !ctrl && DocumentNodes.Type(binding.Node) != "codeBlock") { e.Handled = true; SplitBlock(binding); return; }
        var selection = binding.Editor.Document.Selection;
        if (e.Key == VirtualKey.Back && selection.StartPosition == 0 && selection.EndPosition == 0 && binding.Before == null)
        { e.Handled = JoinBlock(binding); return; }
        if (e.Key == VirtualKey.Up && selection.StartPosition == 0 || e.Key == VirtualKey.Down && selection.EndPosition >= binding.Text.Length)
        {
            int index = _bindings.IndexOf(binding), next = index + (e.Key == VirtualKey.Up ? -1 : 1);
            if (next >= 0 && next < _bindings.Count)
            {
                e.Handled = true; var target = _bindings[next];
                int caret = e.Key == VirtualKey.Up ? target.Text.Length : 0; FocusText(target, caret, caret);
            }
        }
        if (e.Key == VirtualKey.Tab && _activeCell != null)
        {
            var inTable = _cells.Where(c => ReferenceEquals(c.Table, _activeCell.Table)).OrderBy(c => c.Cell.Row).ThenBy(c => c.Cell.Column).ToList();
            int index = inTable.IndexOf(_activeCell) + (shift ? -1 : 1);
            if (index >= 0 && index < inTable.Count)
            {
                e.Handled = true; SelectCell(inTable[index], false); ActivateCell(inTable[index], true);
            }
        }
    }

    private void SplitBlock(TextBinding binding)
    {
        FlushPending(); BreakTypingGroup();
        var selection = binding.Editor.Document.Selection;
        if (selection.StartPosition != selection.EndPosition)
        {
            _loading = true;
            try { selection.Text = ""; } finally { _loading = false; }
            binding.Pending = true; ReadBinding(binding, true);
        }
        int position = InlinePosition(binding, selection.StartPosition);
        var item = DocumentNodes.Ancestor(_nodes, binding.Node, "listItem");
        if (_nodes.Count == 0) _nodes.Add(binding.Node);
        if (DocumentNodes.Locate(_nodes, binding.Node) is not { } place) return;
        if (item != null && DocumentNodes.Text(binding.Node).Length == 0 && DocumentNodes.Children(item).Count() == 1)
        {
            var list = DocumentNodes.Ancestor(_nodes, item, "bulletList") ?? DocumentNodes.Ancestor(_nodes, item, "orderedList");
            if (list != null && DocumentNodes.Locate(_nodes, list) is { } listPlace && DocumentNodes.Locate(_nodes, item) is { } emptyPlace)
            {
                var items = DocumentNodes.Children(list).ToList();
                var before = items.Take(emptyPlace.index).ToList(); var after = items.Skip(emptyPlace.index + 1).ToList();
                var replacements = new List<JsonObject>();
                if (before.Count > 0) { var left = (JsonObject)list.DeepClone(); left["content"] = new JsonArray(before.Select(n => n.DeepClone()).ToArray()); replacements.Add(left); }
                var paragraph = (JsonObject)binding.Node.DeepClone(); if (DocumentNodes.Id(paragraph) == ProtectedHeadingId) DocumentNodes.Attributes(paragraph)["id"] = Guid.NewGuid().ToString(); paragraph["type"] = "paragraph"; replacements.Add(paragraph);
                if (after.Count > 0)
                {
                    var right = (JsonObject)list.DeepClone(); if (before.Count > 0) DocumentNodes.Attributes(right)["id"] = Guid.NewGuid().ToString();
                    right["content"] = new JsonArray(after.Select(n => n.DeepClone()).ToArray()); replacements.Add(right);
                }
                listPlace.parent.RemoveAt(listPlace.index);
                for (int i = 0; i < replacements.Count; i++) listPlace.parent.Insert(listPlace.index + i, replacements[i]);
                if (ReferenceEquals(listPlace.parent, _nodes)) _selectedRoot = DocumentNodes.Id(paragraph);
                Commit(); Render((DocumentNodes.Id(paragraph)!, 0, 0)); return;
            }
        }
        var next = DocumentNodes.SplitParagraph(binding.Node, position); string id = DocumentNodes.Id(next)!;
        if (item != null && DocumentNodes.Locate(_nodes, item) is { } itemPlace)
        {
            var nextItem = new JsonObject { ["type"] = "listItem", ["attrs"] = new JsonObject { ["id"] = Guid.NewGuid().ToString() }, ["content"] = new JsonArray(next) };
            var content = DocumentNodes.Content(item);
            // Blocks following the split paragraph move to the new list item with their original IDs.
            while (content.Count > place.index + 1) { var child = content[place.index + 1]!; content.RemoveAt(place.index + 1); DocumentNodes.Content(nextItem).Add(child); }
            itemPlace.parent.Insert(itemPlace.index + 1, nextItem);
        }
        else { place.parent.Insert(place.index + 1, next); if (ReferenceEquals(place.parent, _nodes)) _selectedRoot = id; }
        Commit(); Render((id, 0, 0));
    }
    private bool JoinBlock(TextBinding binding)
    {
        FlushPending();
        if (DocumentNodes.Locate(_nodes, binding.Node) is not { } place) return false;
        JsonObject? previous = null; JsonArray? removeFrom = null; int removeIndex = -1;
        if (place.index > 0 && place.parent[place.index - 1] is JsonObject candidate && DocumentNodes.Type(candidate) is "paragraph" or "heading" or "codeBlock")
        { previous = candidate; removeFrom = place.parent; removeIndex = place.index; }
        else if (DocumentNodes.Ancestor(_nodes, binding.Node, "listItem") is { } item && DocumentNodes.Locate(_nodes, item) is { } itemPlace && itemPlace.index > 0 && itemPlace.parent[itemPlace.index - 1] is JsonObject previousItem)
        {
            previous = DocumentNodes.Descendants(previousItem).LastOrDefault(n => DocumentNodes.Type(n) is "paragraph" or "heading");
            removeFrom = itemPlace.parent; removeIndex = itemPlace.index;
            if (previous != null)
            {
                foreach (var extra in DocumentNodes.Children(item).Skip(1)) DocumentNodes.Content(previousItem).Add(extra.DeepClone());
            }
        }
        if (previous == null || removeFrom == null) return false;
        int caret = DocumentNodes.Explode(DocumentNodes.Children(previous)).Count; string id = DocumentNodes.Id(previous)!;
        DocumentNodes.JoinParagraph(previous, binding.Node); removeFrom.RemoveAt(removeIndex);
        var root = _nodes.OfType<JsonObject>().FirstOrDefault(n => DocumentNodes.Descendants(n).Any(x => ReferenceEquals(x, previous))); _selectedRoot = root == null ? null : DocumentNodes.Id(root);
        Commit(); Render((id, caret, caret)); return true;
    }

    private void TableCommand(string command)
    {
        var active = _activeCell;
        if (active == null && SelectedRoot() is { } root && DocumentNodes.Type(root) == "table") active = _cells.FirstOrDefault(c => ReferenceEquals(c.Table, root));
        if (active == null) { Notice?.Invoke(this, "请先选择表格单元格。合并时按住 Shift 选择矩形区域。"); return; }
        var table = active.Table; var cell = active.Cell; var focus = CaptureFocus(); bool success = true;
        switch (command)
        {
            case "addRowAfter": NativeTableModel.AddRow(table, cell.Row + cell.RowSpan); break;
            case "deleteRow": success = NativeTableModel.DeleteRow(table, cell.Row); break;
            case "addColumnAfter": NativeTableModel.AddColumn(table, cell.Column + cell.ColumnSpan); break;
            case "deleteColumn": success = NativeTableModel.DeleteColumn(table, cell.Column); break;
            case "splitCell": success = NativeTableModel.Split(table, DocumentNodes.Id(cell.Node)!); break;
            case "mergeCells":
                var selected = _cells.Where(c => ReferenceEquals(c.Table, table) && _selectedCells.Contains(DocumentNodes.Id(c.Cell.Node)!)).ToList();
                success = selected.Count > 1 && NativeTableModel.Merge(table, selected.Min(c => c.Cell.Row), selected.Min(c => c.Cell.Column), selected.Max(c => c.Cell.Row + c.Cell.RowSpan - 1), selected.Max(c => c.Cell.Column + c.Cell.ColumnSpan - 1)); break;
        }
        if (success) { Commit(); Render(focus); }
        else Notice?.Invoke(this, command == "mergeCells" ? "请选择完整的相邻矩形单元格区域，不能截断已有合并单元格。" : "当前选择无法执行该表格操作。");
    }

    private async void OnDrop(object sender, DragEventArgs e)
    {
        if (!e.DataView.Contains(StandardDataFormats.StorageItems)) return;
        e.Handled = true;
        try
        {
            var items = await e.DataView.GetStorageItemsAsync();
            var paths = items.OfType<StorageFile>().Select(f => f.Path).Where(p => new[] { ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tif", ".tiff" }.Contains(Path.GetExtension(p).ToLowerInvariant())).ToList();
            if (paths.Count > 0) ImageDropRequested?.Invoke(this, new NativeImageDropEventArgs(paths));
            else Notice?.Invoke(this, "请拖入图片文件。Word 文档请使用导入功能。");
        }
        catch (Exception ex) { Notice?.Invoke(this, "拖入图片失败：" + ex.Message); }
    }
}
