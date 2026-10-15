using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using AgentDocument.Client;
using AgentDocument.WinUI.Controls;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;
using Windows.Storage.Pickers;
using Windows.System;
using WinRT.Interop;
using DispatcherQueueTimer = Microsoft.UI.Dispatching.DispatcherQueueTimer;

namespace AgentDocument.WinUI;

public sealed partial class MainWindow : Window
{
    private readonly ServiceClient _client;
    private readonly EditorSession _session;
    private readonly NativeDocumentEditor _editor = new();
    private readonly DispatcherQueueTimer _autoSave;
    private readonly DispatcherQueueTimer _poll;
    private readonly string _workspace;
    private readonly string? _initialProject;
    private readonly string? _diagnosticPath;
    private bool _ready, _rendering, _switching, _polling, _allowClose, _closing, _styleRendering, _styleDirty, _advancedDirty, _exclusive, _draftExported, _blockListSyncing;
    private long _styleRevision;
    private long _shownContentGeneration = -1, _shownTreeGeneration = -1, _shownStyleGeneration = -1;
    private JsonObject _styleDraft = new();
    private JsonObject _styleOriginal = new();
    private string? _styleProjectId;
    private bool _showHome = true;
    private CommonStyleValues? _shownCommonStyle;
    private record CommonStyleValues(string Font, string Latin, double Size, bool Bold, int Alignment, int Line, double Before, double After, double Indent);
    public sealed record ProjectListItem(string Title, string Path, string Modified, bool Available, string Error);
    private readonly Stack<MoveHistory> _moveUndo = new(), _moveRedo = new();
    private readonly ComboBox _fontName = new() { Width = 135, IsEditable = true };
    private readonly ComboBox _fontSize = new() { Width = 72, IsEditable = true };
    private readonly JsonSerializerOptions _pretty = new() { WriteIndented = true };
    private readonly Button _draftButton = new() { Content = "保存本地草稿" };
    private readonly Button _reloadButton = new() { Content = "读取已保存版本" };
    private Button? _ribbonCopyButton, _ribbonPasteButton;
    private readonly Dictionary<string, TreeViewNode> _treeNodes = new();
    private readonly Dictionary<string, bool> _treeExpansion = new();
    private record LabelItem(string Id, string Title) { public string AutomationId => "MoveSection_" + Id; public override string ToString() => Title; }
    private record MoveHistory(string BlockId, string SourceId, string TargetId, string? BeforeId, long BlockRevision);
    private static string? Arg(string name)
    {
        var args = Environment.GetCommandLineArgs(); var i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }
    private static string FindWorkspace()
    {
        var candidate = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; candidate is not null && i < 8; i++, candidate = candidate.Parent)
            if (File.Exists(Path.Combine(candidate.FullName, "src", "service.js")) && File.Exists(Path.Combine(candidate.FullName, "package.json"))) return candidate.FullName;
        return AppContext.BaseDirectory;
    }
    private static string Str(JsonNode? value, string fallback = "") => value?.GetValue<string>() ?? fallback;
    private static long Rev(JsonNode? value) => value?["revision"]?.GetValue<long>() ?? 0;
    private JsonObject? CurrentSection => _session.BaseSection;
    private string? CurrentProjectPath => _session.Project?["path"]?.GetValue<string>();
    private Task<JsonNode> ProjectToolAsync(string name, JsonObject args)
    {
        args["project_id"] = _session.Project?["id"]?.DeepClone(); return _client.ToolAsync(name, args);
    }

    public MainWindow()
    {
        InitializeComponent();
        Title = "Agent Document · 文档工作台";
        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico"));
        AppWindow.Resize(new Windows.Graphics.SizeInt32(1480, 980));
        if (AppWindow.Presenter is OverlappedPresenter presenter) { presenter.PreferredMinimumWidth = 1024; presenter.PreferredMinimumHeight = 720; }
        _workspace = Path.GetFullPath(Arg("--workspace") ?? FindWorkspace());
        var runtime = Arg("--runtime") ?? Environment.GetEnvironmentVariable("AGENTDOC_RUNTIME") ?? Path.Combine(_workspace, ".runtime-local");
        var port = int.TryParse(Arg("--port") ?? Environment.GetEnvironmentVariable("AGENTDOC_PORT"), out var n) ? n : 47831;
        _initialProject = Arg("--project"); _diagnosticPath = Arg("--diagnostics");
        _client = new ServiceClient(_workspace, runtime, port); _session = new EditorSession(_client);
        EditorHost.Children.Add(_editor); _editor.Visibility = Visibility.Collapsed;
        _editor.NodesChanged += (_, _) =>
        {
            if (!_ready || _rendering || _session.Project is null) return;
            try { _draftExported = false; _session.SetChangedNodes(_editor.GetChangedNodes(), _editor.NodeOrder); _shownContentGeneration = _session.ContentGeneration; _autoSave?.Stop(); _autoSave?.Start(); UpdateStatus(); UpdateInspector(); WriteDiagnostics(); }
            catch (Exception e) { ShowError(e); }
        };
        _editor.SelectionChanged += (_, _) => { if (_ready && !_rendering) { UpdateInspector(); WriteDiagnostics(); } };
        _editor.RequestImagePaste += (_, _) => Run(PasteImageAsync);
        _editor.Notice += (_, message) => Inform(message);
        _editor.ImageDropRequested += (_, e) => Run(async () => { foreach (var file in e.Files) await InsertImageFileAsync(file); });
        _editor.ImportImageAssetAsync = async (bytes, name) =>
        {
            var projectId = Str(_session.Project?["id"]); var projectPath = CurrentProjectPath;
            var current = await _client.GetProjectAsync();
            if (Str(current?["id"]) != projectId || CurrentProjectPath != projectPath) throw new ServiceException("项目已切换，请在目标项目重新粘贴图片。", 409);
            var asset = await _client.AddAssetAsync(bytes, name, projectId);
            if (Str(_session.Project?["id"]) != projectId) throw new ServiceException("项目已切换，本次粘贴未修改正文。", 409);
            return Str(asset["src"]);
        };
        _autoSave = DispatcherQueue.CreateTimer(); _autoSave.Interval = TimeSpan.FromMilliseconds(500); _autoSave.IsRepeating = false;
        _autoSave.Tick += (_, _) => Run(SaveAsync);
        _poll = DispatcherQueue.CreateTimer(); _poll.Interval = TimeSpan.FromMilliseconds(1000);
        _poll.Tick += (_, _) => Run(PollAsync);
        _draftButton.Click += (_, _) => Run(SaveDraftAsync);
        _reloadButton.Click += (_, _) => Run(ReloadConflictAsync);
        Notice.ActionButton = new Button { Content = "处理草稿" };
        Notice.ActionButton.Click += (_, _) => Run(ConflictDialogAsync);
        BuildRibbon(); InitializeStylesControls(); UpdateClipboardAvailability();
        Root.Loaded += (_, _) => Run(InitializeAsync);
        Root.KeyDown += Root_KeyDown;
        AppWindow.Closing += AppWindow_Closing;
        Closed += (_, _) => { _autoSave.Stop(); _poll.Stop(); _client.Dispose(); };
    }

    private async void Run(Func<Task> action)
    {
        try { await action(); } catch (Exception e) { ShowError(e); }
    }
    private async Task ExclusiveAsync(Func<Task> action)
    {
        if (_exclusive) { Inform("上一项操作仍在完成，请稍候。"); return; }
        _exclusive = true; _editor.IsEnabled = false; StyleInspector.IsEnabled = false; _autoSave.Stop(); UpdateClipboardAvailability();
        try { await action(); }
        finally { _exclusive = false; _editor.IsEnabled = true; StyleInspector.IsEnabled = _session.Project is not null; UpdateClipboardAvailability(); if (_session.Dirty && !_session.Conflicted) _autoSave.Start(); WriteDiagnostics(); }
    }
    private void ShowError(Exception e)
    {
        Notice.Severity = e is ServiceException { StatusCode: 409 } ? InfoBarSeverity.Warning : InfoBarSeverity.Error;
        Notice.Title = _session.Conflicted ? "内容发生并发变化" : "操作未完成";
        Notice.Message = _session.Conflicted ? "你的输入已保留为本地草稿。保存草稿或读取已保存版本后继续编辑。" : e.Message;
        Notice.IsOpen = true; Notice.ActionButton.Visibility = _session.Conflicted ? Visibility.Visible : Visibility.Collapsed;
        UpdateStatus(); WriteDiagnostics();
    }
    private void Inform(string message)
    {
        Notice.Title = ""; Notice.Message = message; Notice.Severity = InfoBarSeverity.Informational;
        Notice.ActionButton.Visibility = Visibility.Collapsed; Notice.IsOpen = true;
    }
    private async Task InitializeAsync()
    {
        if (_ready) return;
        await _client.ConnectAsync();
        if (_initialProject is not null) { await _session.LoadProjectAsync(await _client.OpenProjectAsync(_initialProject)); _showHome = false; }
        _ready = true; SetProjectView(_showHome); RenderProject(true); _poll.Start();
        if (_showHome) await RefreshProjectsAsync();
        if (_session.Conflicted) ShowError(new ServiceException("发现上次未提交的本地草稿", 409));
    }
    private void BuildRibbon()
    {
        Button Button(StackPanel row, string label, string id, Action action, string? glyph = null)
        {
            var button = new Button { Padding = new Thickness(9, 5, 9, 5), MinWidth = 38 };
            var panel = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 5 };
            if (glyph is not null) panel.Children.Add(new FontIcon { Glyph = glyph, FontSize = 15 });
            panel.Children.Add(new TextBlock { Text = label }); button.Content = panel;
            AutomationProperties.SetAutomationId(button, "Ribbon_" + id);
            ToolTipService.SetToolTip(button, label); button.Click += (_, _) => action(); row.Children.Add(button); return button;
        }
        (StackPanel Top, StackPanel Bottom) Group(StackPanel ribbon, string label)
        {
            var top = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
            var bottom = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
            var stack = new StackPanel { Spacing = 5 };
            stack.Children.Add(top); stack.Children.Add(bottom);
            stack.Children.Add(new TextBlock { Text = label, FontSize = 11, Foreground = new SolidColorBrush(Microsoft.UI.Colors.DimGray), HorizontalAlignment = HorizontalAlignment.Center });
            ribbon.Children.Add(new Border { Child = stack, Padding = new Thickness(0, 0, 12, 0), BorderBrush = new SolidColorBrush(Microsoft.UI.ColorHelper.FromArgb(255, 225, 223, 221)), BorderThickness = new Thickness(0, 0, 1, 0) });
            return (top, bottom);
        }
        var edit = Group(HomeRibbon, "编辑");
        Button(edit.Top, "撤销", "Undo", Undo, "\uE7A7"); Button(edit.Top, "重做", "Redo", Redo, "\uE7A6");
        Button(edit.Bottom, "插入段落", "InsertParagraph", () => NativeAction(_editor.InsertParagraphAfterSelection));
        var font = Group(HomeRibbon, "行内语义");
        Button(font.Top, "统一文档样式", "ExportTypography", () => SelectRibbon("layout"));
        Button(font.Bottom, "粗体", "Bold", () => Command("bold")); Button(font.Bottom, "斜体", "Italic", () => Command("italic"));
        Button(font.Bottom, "上标", "Superscript", () => Command("superscript")); Button(font.Bottom, "下标", "Subscript", () => Command("subscript"));
        Button(font.Bottom, "下划线", "Underline", () => Command("underline")); Button(font.Bottom, "删除线", "Strike", () => Command("strike"));
        var paragraph = Group(HomeRibbon, "段落");
        Button(paragraph.Top, "正文", "Paragraph", () => Command("paragraph")); Button(paragraph.Top, "标题", "Heading", () => Command("heading"));
        Button(paragraph.Top, "项目符号", "BulletList", () => Command("bulletList")); Button(paragraph.Top, "编号", "OrderedList", () => Command("orderedList"));
        Button(paragraph.Bottom, "章节组织", "SectionOrganize", () => Run(() => ExclusiveAsync(EditSectionAsync)));
        var navigation = Group(HomeRibbon, "文档"); Button(navigation.Top, "表格", "QuickTable", () => { SelectRibbon("insert"); Command("table"); });
        Button(navigation.Top, "图片", "QuickImage", () => Run(ChooseImageAsync)); Button(navigation.Bottom, "样式", "Styles", () => { SelectInspector("style"); SelectRibbon("layout"); });
        var insert = Group(InsertRibbon, "插入"); Button(insert.Top, "插入表格", "InsertTable", () => Command("table"), "\uE80A"); Button(insert.Top, "插入图片", "InsertImage", () => Run(ChooseImageAsync), "\uE91B");
        Button(insert.Bottom, "插入段落", "InsertBlock", () => NativeAction(_editor.InsertParagraphAfterSelection)); Button(insert.Bottom, "新增章节", "AddSection", () => Run(() => ExclusiveAsync(AddSectionAsync)));
        var table = Group(InsertRibbon, "表格布局");
        Button(table.Top, "增加行", "AddRow", () => Command("addRowAfter")); Button(table.Top, "删除行", "DeleteRow", () => Command("deleteRow"));
        Button(table.Top, "增加列", "AddColumn", () => Command("addColumnAfter")); Button(table.Top, "删除列", "DeleteColumn", () => Command("deleteColumn"));
        Button(table.Bottom, "合并单元格", "MergeCells", () => Command("mergeCells")); Button(table.Bottom, "拆分单元格", "SplitCell", () => Command("splitCell"));
        var layout = Group(LayoutRibbon, "文档样式"); Button(layout.Top, "正文和标题", "CommonStyles", () => SelectInspector("style"));
        Button(layout.Top, "页面设置", "PageSetup", () => Run(PageSetupAsync)); Button(layout.Bottom, "导入预设", "ImportPreset", () => Run(ImportPresetAsync)); Button(layout.Bottom, "导出预设", "ExportPreset", () => Run(ExportPresetAsync));
        var source = Group(LayoutRibbon, "文档模板"); Button(source.Top, "详细样式", "AdvancedStyles", () => { SelectRibbon("layout"); AdvancedStylesFlyout.ShowAt(DetailedStylesButton); });
        Button(source.Bottom, "还原未保存样式", "ReloadStyles", () => { _styleDirty = _advancedDirty = false; LoadStyles(true); });
        var blocks = Group(ReviewRibbon, "内容块");
        _ribbonCopyButton = Button(blocks.Top, "复制", "CopyBlock", () => Run(() => NativeClipboardActionAsync(_editor.CopySelectedBlocksToClipboardAsync)));
        _ribbonPasteButton = Button(blocks.Top, "粘贴", "PasteBlock", () => Run(() => NativeClipboardActionAsync(_editor.PasteClipboardAsync)));
        Button(blocks.Top, "删除", "DeleteBlock", () => NativeAction(_editor.DeleteSelected));
        Button(blocks.Top, "上移", "UpBlock", () => NativeAction(() => _editor.MoveSelected(-1))); Button(blocks.Top, "下移", "DownBlock", () => NativeAction(() => _editor.MoveSelected(1)));
        Button(blocks.Bottom, "拆分段落", "SplitBlock", () => Command("splitBlock")); Button(blocks.Bottom, "合并段落", "JoinBlock", () => Command("joinBlock"));
        var review = Group(ReviewRibbon, "审阅"); Button(review.Top, "导入提示", "Warnings", () => Run(async () => await DialogAsync("导入提示", Warnings.Text)));
        Button(review.Top, "本地草稿", "Draft", () => Run(SaveDraftAsync)); Button(review.Bottom, "重新读取", "Reload", () => Run(ReloadConflictAsync));
    }
    private static string EditableText(ComboBox box)
    {
        static TextBox? Find(DependencyObject element)
        {
            for (var i = 0; i < VisualTreeHelper.GetChildrenCount(element); i++)
            {
                var child = VisualTreeHelper.GetChild(element, i); if (child is TextBox text) return text; var nested = Find(child); if (nested is not null) return nested;
            }
            return null;
        }
        return Find(box)?.Text ?? box.Text ?? box.SelectedItem?.ToString() ?? "";
    }
    private void Command(string command) => NativeAction(() => _editor.Execute(command));
    private void NativeAction(Action action)
    {
        if (_exclusive) { Inform("正在保存或切换文档，请稍候。"); return; }
        if (_session.Project is null) { Inform("请先新建、导入或打开项目。 "); return; }
        if (_session.Conflicted) { ShowError(new ServiceException("请先处理草稿冲突", 409)); return; }
        try { action(); WriteDiagnostics(); } catch (Exception ex) { ShowError(ex); }
    }
    private async Task NativeClipboardActionAsync(Func<Task> action)
    {
        if (!_ready || _exclusive || _switching || _closing) { Inform("正在保存或切换文档，请稍候。"); return; }
        if (_session.Project is null) { Inform("请先新建、导入或打开项目。"); return; }
        if (CurrentSection is null) { Inform("请先选择一个章节。"); return; }
        if (_session.Conflicted) { ShowError(new ServiceException("请先处理草稿冲突", 409)); return; }
        await action(); WriteDiagnostics();
    }
    private void SelectRibbon(string name)
    {
        HomeTab.IsChecked = name == "home"; InsertTab.IsChecked = name == "insert"; LayoutTab.IsChecked = name == "layout"; ReviewTab.IsChecked = name == "review";
        HomeRibbon.Visibility = name == "home" ? Visibility.Visible : Visibility.Collapsed;
        InsertRibbon.Visibility = name == "insert" ? Visibility.Visible : Visibility.Collapsed;
        LayoutRibbon.Visibility = name == "layout" ? Visibility.Visible : Visibility.Collapsed;
        ReviewRibbon.Visibility = name == "review" ? Visibility.Visible : Visibility.Collapsed;
    }
    private void RibbonTab_Click(object sender, RoutedEventArgs e) => SelectRibbon((string)((FrameworkElement)sender).Tag);
    private void SelectInspector(string name)
    {
        if (name == "style") SelectRibbon("layout");
        else InspectorColumn.Width = new GridLength(300);
    }
    private void InspectorTab_Click(object sender, RoutedEventArgs e) => SelectInspector((string)((FrameworkElement)sender).Tag);
    private void RenderProject(bool loadEditor = false, bool keepHistory = false)
    {
        _rendering = true;
        try
        {
            var project = _session.Project;
            if (project is null) { StatusText.Text = "新建、打开或导入文档"; UpdateClipboardAvailability(); WriteDiagnostics(); return; }
            SetProjectView(_showHome); ProjectPath.Text = Str(project["path"]); SectionTitle.Text = Str(CurrentSection?["title"], "文档");
            Warnings.Text = string.Join("\n\n", (project["warnings"] as JsonArray ?? []).Select(x => x?.ToString())); if (Warnings.Text.Length == 0) Warnings.Text = "没有需要提示的转换问题。";
            EmptyState.Visibility = Visibility.Collapsed; _editor.Visibility = Visibility.Visible;
            _editor.ProtectedHeadingId = CurrentSection?["headingBlockId"]?.GetValue<string>();
            if (_session.PendingIdMappings.Count > 0) { _editor.RemapIds(_session.PendingIdMappings); _session.PendingIdMappings.Clear(); }
            if (loadEditor || _shownContentGeneration != _session.ContentGeneration || _shownStyleGeneration != _session.StyleGeneration)
            { _editor.LoadNodes(_session.Nodes, CurrentProjectPath, project["styles"] as JsonObject, keepHistory, loadEditor ? null : _session.PendingRenderBlockIds); _session.PendingRenderBlockIds.Clear(); _shownContentGeneration = _session.ContentGeneration; }
            if (_styleProjectId is not null && _styleProjectId != Str(project["id"]) && (_styleDirty || _advancedDirty))
            {
                var draft = new JsonObject { ["projectId"] = _styleProjectId, ["styles"] = _styleDraft.DeepClone(), ["scope"] = StyleScope.SelectedIndex, ["advancedText"] = StylesEditor.Text };
                var path = Path.Combine(_client.RuntimeDirectory, "drafts", "styles-project-change-" + DateTime.Now.ToString("yyyyMMdd-HHmmssfff") + ".json"); Directory.CreateDirectory(Path.GetDirectoryName(path)!); File.WriteAllText(path, draft.ToJsonString(_pretty));
                _styleDirty = _advancedDirty = false; Inform("活动项目已切换，之前未提交的样式副本保存在 " + path);
            }
            if (loadEditor || _shownTreeGeneration != _session.TreeGeneration) { RenderTree(); _shownTreeGeneration = _session.TreeGeneration; }
            RenderBlockList();
            if (loadEditor || _shownStyleGeneration != _session.StyleGeneration) { LoadStyles(false); _shownStyleGeneration = _session.StyleGeneration; }
            UpdateInspector(); UpdateStatus(); WriteDiagnostics();
        }
        finally { _rendering = false; }
    }
    private void RenderTree(bool rebuild = false)
    {
        if (rebuild)
        {
            foreach (var pair in _treeNodes) _treeExpansion[pair.Key] = pair.Value.IsExpanded;
            ChapterTree.RootNodes.Clear(); _treeNodes.Clear();
        }
        var selection = _session.SectionId;
        var sections = (_session.Project?["sections"] as JsonArray ?? []).OfType<JsonObject>().ToArray(); var filter = ChapterSearch.Text.Trim();
        var visible = sections.Where(s => filter.Length == 0 || Str(s["title"]).Contains(filter, StringComparison.OrdinalIgnoreCase)).ToArray();
        var ids = visible.Select(s => Str(s["id"])).ToHashSet();
        foreach (var old in _treeNodes.Keys.Where(id => !ids.Contains(id)).ToArray())
        {
            var node = _treeNodes[old]; _treeExpansion[old] = node.IsExpanded;
            if (node.Parent != null) node.Parent.Children.Remove(node); else ChapterTree.RootNodes.Remove(node);
            _treeNodes.Remove(old);
        }
        foreach (var section in visible)
        {
            var id = Str(section["id"]); var title = Str(section["title"]);
            if (!_treeNodes.TryGetValue(id, out var node))
            {
                var text = new TextBlock { Text = title, FontSize = 13, TextTrimming = TextTrimming.CharacterEllipsis, Tag = id };
                AutomationProperties.SetAutomationId(text, "Section_" + id);
                _treeNodes[id] = new TreeViewNode { Content = text, IsExpanded = !_treeExpansion.TryGetValue(id, out var expanded) || expanded };
            }
            else if (node.Content is TextBlock text && text.Text != title) text.Text = title;
        }
        // Move only nodes whose parent or index changed; retain expansion and selection objects.
        var grouped = visible.GroupBy(s => filter.Length == 0 && ids.Contains(Str(s["parentId"])) ? Str(s["parentId"]) : "");
        foreach (var group in grouped)
        {
            var target = group.Key.Length == 0 ? ChapterTree.RootNodes : _treeNodes[group.Key].Children;
            int index = 0;
            foreach (var section in group.OrderBy(s => s["order"]?.GetValue<double>() ?? 0))
            {
                var node = _treeNodes[Str(section["id"])];
                if (index < target.Count && ReferenceEquals(target[index], node)) { index++; continue; }
                if (node.Parent != null) node.Parent.Children.Remove(node); else ChapterTree.RootNodes.Remove(node);
                // A TextBlock still owned by a recycled TreeView container cannot be reparented reliably.
                // Keep the Section node identity but give a moved item a fresh presentation element.
                if (node.Content is TextBlock previousText)
                {
                    var text = new TextBlock { Text = previousText.Text, FontSize = 13, TextTrimming = TextTrimming.CharacterEllipsis, Tag = previousText.Tag };
                    AutomationProperties.SetAutomationId(text, "Section_" + Str(section["id"])); node.Content = text;
                }
                target.Insert(index++, node);
            }
        }
        if (selection is not null && _treeNodes.TryGetValue(selection, out var selected)) ChapterTree.SelectedNode = selected;
        var targetId = (MoveTarget.SelectedItem as LabelItem)?.Id;
        MoveTarget.ItemsSource = sections.Where(s => Str(s["id"]) != selection).Select(s => new LabelItem(Str(s["id"]), Str(s["title"]))).ToList();
        if (targetId is not null) MoveTarget.SelectedItem = (MoveTarget.ItemsSource as List<LabelItem>)?.FirstOrDefault(x => x.Id == targetId);
    }
    private void RenderBlockList()
    {
        if (_blockListSyncing) return;
        var selected = _editor.SelectedBlockIds.ToHashSet();
        if (selected.Count == 0 && _editor.SelectedRootId is string current) selected.Add(current);
        var labels = _session.Nodes.OfType<JsonObject>().Select(n => new LabelItem(JsonData.Id(n)!, $"{FriendlyType(Str(n["type"]))}　{Clip(_session.BlockText(JsonData.Id(n)), 30)}")).ToList();
        _blockListSyncing = true;
        try
        {
            if (BlockList.ItemsSource is List<LabelItem> shown && shown.SequenceEqual(labels)) labels = shown;
            else BlockList.ItemsSource = labels;
            foreach (var item in BlockList.SelectedItems.OfType<LabelItem>().Where(item => !selected.Contains(item.Id)).ToArray()) BlockList.SelectedItems.Remove(item);
            foreach (var item in labels.Where(item => selected.Contains(item.Id)))
                if (!BlockList.SelectedItems.Contains(item)) BlockList.SelectedItems.Add(item);
        }
        finally { _blockListSyncing = false; }
    }
    private static string Clip(string text, int length) => text.Length <= length ? text : text[..length] + "…";
    private static string FriendlyType(string type) => type switch { "paragraph" => "正文", "heading" => "标题", "table" => "表格", "image" => "图片", "bulletList" => "项目列表", "orderedList" => "编号列表", "blockquote" => "引用", "codeBlock" => "代码", "horizontalRule" => "分隔线", _ => "内容" };
    private void UpdateInspector()
    {
        var id = _editor.SelectedRootId;
        var node = _session.Nodes.FirstOrDefault(x => JsonData.Id(x) == id);
        BlockType.Text = node is null ? "选择一个内容块" : FriendlyType(Str(node["type"])); BlockId.Text = id ?? "";
        BlockSummary.Text = node is null ? "" : Clip(_session.BlockText(JsonData.Id(node)), 180);
        var block = (CurrentSection?["blocks"] as JsonArray)?.FirstOrDefault(x => JsonData.Id(x) == id); BlockRevision.Text = block is null ? "新内容，等待保存" : "已保存块版本 " + Rev(block);
        if (!_rendering) { _rendering = true; try { RenderBlockList(); } finally { _rendering = false; } }
        UpdateClipboardAvailability();
    }
    private void UpdateClipboardAvailability()
    {
        var available = _ready && !_exclusive && !_switching && !_closing && !_session.Conflicted && _session.Project is not null && CurrentSection is not null;
        var canCopy = available && (_editor.SelectedRootId is not null || _editor.SelectedBlockIds.Count > 0);
        CopySelectionButton.IsEnabled = canCopy; PasteSelectionButton.IsEnabled = available;
        if (_ribbonCopyButton is not null) _ribbonCopyButton.IsEnabled = canCopy;
        if (_ribbonPasteButton is not null) _ribbonPasteButton.IsEnabled = available;
    }
    private void UpdateStatus()
    {
        StatusText.Text = _session.Conflicted ? "存在并发冲突，草稿已保留" : _session.Dirty ? "编辑中，等待自动保存…" : _showHome ? "项目保存在本地" : "已保存到本地";
        if (_session.DraftPersistenceError is not null) StatusText.Text += "，草稿文件未能写入，请立即保存";
        var chars = _session.CharacterCount; Statistics.Text = _showHome ? $"{RecentProjects.Items.Count} 个项目" : $"{(_session.Project?["sections"] as JsonArray)?.Count ?? 0} 个章节　{_session.Nodes.Count} 个内容块　{chars} 字符";
        UpdateClipboardAvailability();
    }
    private async Task SaveAsync()
    {
        _autoSave.Stop(); if (_session.Project is null) return;
        if (_editor.IsComposing) { _autoSave.Start(); return; }
        _editor.FlushEdits();
        await _session.SaveAsync(); RenderProject(keepHistory: true);
    }
    private async Task PollAsync()
    {
        if (!_ready || _polling || _switching || _closing || _exclusive || _editor.IsComposing || _session.Project is null) return;
        _polling = true;
        try
        {
            var revision = Rev(_session.Project); var generation = _session.ContentGeneration;
            await _session.RefreshAsync();
            if (revision != Rev(_session.Project) || generation != _session.ContentGeneration) RenderProject();
        }
        finally { _polling = false; WriteDiagnostics(); }
    }
    private async void ChapterTree_SelectionChanged(TreeView sender, TreeViewSelectionChangedEventArgs args)
    {
        if (_rendering || _switching || _exclusive || sender.SelectedNode?.Content is not TextBlock text || text.Tag is not string id || id == _session.SectionId) return;
        _switching = true; UpdateClipboardAvailability();
        try { await _session.SwitchSectionAsync(id); _editor.ResetHistory(); RenderProject(true); }
        catch (Exception e) { ShowError(e); _rendering = true; try { if (_session.SectionId is not null && _treeNodes.TryGetValue(_session.SectionId, out var node)) ChapterTree.SelectedNode = node; } finally { _rendering = false; } }
        finally { _switching = false; UpdateClipboardAvailability(); }
    }
    private void ChapterSearch_TextChanged(object sender, TextChangedEventArgs e) { if (_ready) { _rendering = true; try { RenderTree(rebuild: true); } finally { _rendering = false; } } }
    private void BlockList_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_rendering || _blockListSyncing || _exclusive || _switching) return;
        var ids = BlockList.SelectedItems.OfType<LabelItem>().Select(item => item.Id).ToArray();
        var current = e.AddedItems.OfType<LabelItem>().LastOrDefault()?.Id;
        if (current is null) current = ids.Contains(_editor.SelectedRootId) ? _editor.SelectedRootId : ids.LastOrDefault();
        _blockListSyncing = true;
        try { _editor.SelectRoots(ids, current); }
        finally { _blockListSyncing = false; }
    }
    private void Save_Click(object sender, RoutedEventArgs e) => Run(SaveAsync);
    private void NewProject_Click(object sender, RoutedEventArgs e) => Run(() => ExclusiveAsync(() => ProjectDialogAsync(false)));
    private void Import_Click(object sender, RoutedEventArgs e) => Run(() => ExclusiveAsync(ImportWordAsync));
    private void OpenProject_Click(object sender, RoutedEventArgs e) => Run(() => ExclusiveAsync(ShowProjectHomeAsync));
    private void BrowseProject_Click(object sender, RoutedEventArgs e) => Run(() => ExclusiveAsync(OpenProjectAsync));
    private void RefreshProjects_Click(object sender, RoutedEventArgs e) => Run(() => ExclusiveAsync(RefreshProjectsAsync));
    private void ContinueProject_Click(object sender, RoutedEventArgs e) { if (_session.Project is not null) { SetProjectView(false); UpdateStatus(); WriteDiagnostics(); } }
    private void RecentProjects_ItemClick(object sender, ItemClickEventArgs e) => Run(() => ExclusiveAsync(async () =>
    {
        if (e.ClickedItem is not ProjectListItem item) return;
        if (!item.Available) { Inform("无法打开此项目：" + item.Error + "。请通过“浏览已有项目”选择新的位置。"); return; }
        if (string.Equals(CurrentProjectPath, item.Path, StringComparison.OrdinalIgnoreCase)) { SetProjectView(false); UpdateStatus(); return; }
        if (!await ReadyForProjectChangeAsync()) return;
        await AdoptProjectAsync(await _client.OpenProjectAsync(item.Path));
    }));
    private void AddSection_Click(object sender, RoutedEventArgs e) => Run(() => ExclusiveAsync(AddSectionAsync));
    private void Export_Click(object sender, RoutedEventArgs e) => Run(ExportAsync);
    private void InsertBlock_Click(object sender, RoutedEventArgs e) => NativeAction(_editor.InsertParagraphAfterSelection);
    private void CopyBlock_Click(object sender, RoutedEventArgs e) => Run(() => NativeClipboardActionAsync(_editor.CopySelectedBlocksToClipboardAsync));
    private void PasteBlock_Click(object sender, RoutedEventArgs e) => Run(() => NativeClipboardActionAsync(_editor.PasteClipboardAsync));
    private void DeleteBlock_Click(object sender, RoutedEventArgs e) => NativeAction(_editor.DeleteSelected);
    private void UpBlock_Click(object sender, RoutedEventArgs e) => NativeAction(() => _editor.MoveSelected(-1));
    private void DownBlock_Click(object sender, RoutedEventArgs e) => NativeAction(() => _editor.MoveSelected(1));
    private void MoveBlock_Click(object sender, RoutedEventArgs e) => Run(() => ExclusiveAsync(MoveBlockAsync));
    private void ReadingSpace_Click(object sender, RoutedEventArgs e)
    {
        var collapsed = NavColumn.Width.Value == 0; NavColumn.MinWidth = collapsed ? 180 : 0; NavColumn.Width = new GridLength(collapsed ? 260 : 0); InspectorColumn.Width = new GridLength(collapsed ? 300 : 0);
    }
    private async Task<bool> ReadyForProjectChangeAsync()
    {
        if (_editor.IsComposing) { Inform("请先完成当前文字输入，再切换项目。"); return false; }
        await SaveAsync(); if (_session.Conflicted) return false;
        if (!_styleDirty && !_advancedDirty) return true;
        var result = await new ContentDialog { XamlRoot = Root.XamlRoot, Title = "样式尚未保存", Content = "继续打开其他项目会放弃本次未保存的样式设置。", PrimaryButtonText = "继续", CloseButtonText = "取消", DefaultButton = ContentDialogButton.Close }.ShowAsync();
        return result == ContentDialogResult.Primary;
    }
    private async Task AdoptProjectAsync(JsonObject project)
    {
        await _session.LoadProjectAsync(project); _moveUndo.Clear(); _moveRedo.Clear(); _editor.ResetHistory(); _styleDirty = _advancedDirty = _draftExported = false; SetProjectView(false); RenderProject(true);
    }
    private void SetProjectView(bool home)
    {
        _showHome = home; ProjectHome.Visibility = home ? Visibility.Visible : Visibility.Collapsed;
        RibbonHost.Visibility = WorkspaceGrid.Visibility = home ? Visibility.Collapsed : Visibility.Visible;
        ContinueProjectButton.Visibility = _session.Project is null ? Visibility.Collapsed : Visibility.Visible;
        SaveProjectButton.IsEnabled = ExportProjectButton.IsEnabled = !home && _session.Project is not null;
        StyleInspector.IsEnabled = !_exclusive && _session.Project is not null;
        ProjectTitle.Text = home ? "项目首页" : Str(_session.Project?["title"], "文档");
        Title = home ? "Agent Document · 文档工作台" : ProjectTitle.Text + " — 文档工作台";
    }
    private async Task RefreshProjectsAsync()
    {
        var projects = await _client.ListProjectsAsync(Path.Combine(_workspace, "projects"));
        RecentProjects.ItemsSource = projects.OfType<JsonObject>().Select(p => new ProjectListItem(Str(p["title"]), Str(p["path"]), p["available"]?.GetValue<bool>() == true ? DateTimeOffset.TryParse(Str(p["updatedAt"]), out var date) ? date.LocalDateTime.ToString("yyyy-MM-dd HH:mm") : "—" : "位置不可用", p["available"]?.GetValue<bool>() == true, Str(p["error"]))).ToList();
        ProjectsEmpty.Visibility = projects.Count == 0 ? Visibility.Visible : Visibility.Collapsed; UpdateStatus(); WriteDiagnostics();
    }
    private async Task ShowProjectHomeAsync()
    {
        if (_editor.IsComposing) { Inform("请先完成当前文字输入。"); return; }
        await SaveAsync(); if (_session.Conflicted) return;
        SetProjectView(true); await RefreshProjectsAsync();
    }
    private async Task ImportWordAsync()
    {
        if (!await ReadyForProjectChangeAsync()) return;
        var source = await FilePicker(".docx").PickSingleFileAsync(); if (source is null) return;
        var title = Path.GetFileNameWithoutExtension(source.Name);
        var directory = ProjectPaths.NewDirectory(Path.Combine(_workspace, "projects"), title);
        await AdoptProjectAsync(await _client.CreateProjectAsync(directory, title, await File.ReadAllBytesAsync(source.Path), source.Name, freshDocument: true));
    }
    private FolderPicker FolderPicker()
    {
        var picker = new FolderPicker(); picker.FileTypeFilter.Add("*"); InitializeWithWindow.Initialize(picker, WindowNative.GetWindowHandle(this)); return picker;
    }
    private FileOpenPicker FilePicker(params string[] types)
    {
        var picker = new FileOpenPicker(); foreach (var type in types) picker.FileTypeFilter.Add(type); InitializeWithWindow.Initialize(picker, WindowNative.GetWindowHandle(this)); return picker;
    }
    private FileSavePicker SavePicker(string name, string extension)
    {
        var picker = new FileSavePicker { SuggestedFileName = name }; picker.FileTypeChoices.Add(extension, [extension]); InitializeWithWindow.Initialize(picker, WindowNative.GetWindowHandle(this)); return picker;
    }
    private async Task OpenProjectAsync()
    {
        if (!await ReadyForProjectChangeAsync()) return; var folder = await FolderPicker().PickSingleFolderAsync(); if (folder is null) return; await AdoptProjectAsync(await _client.OpenProjectAsync(folder.Path));
    }
    private async Task ProjectDialogAsync(bool import)
    {
        if (!await ReadyForProjectChangeAsync()) return; StorageFile? source = null;
        if (import) { source = await FilePicker(".docx").PickSingleFileAsync(); if (source is null) return; }
        var name = new TextBox { Header = "项目名称", Text = source is null ? "工程技术文档" : Path.GetFileNameWithoutExtension(source.Name) };
        var path = new TextBox { Header = "新的项目文件夹", Text = Path.Combine(_workspace, "projects", "项目-" + DateTime.Now.ToString("yyyyMMdd-HHmmss")), MinWidth = 460 };
        var choose = new Button { Content = "选择文件夹…" }; choose.Click += async (_, _) => { var folder = await FolderPicker().PickSingleFolderAsync(); if (folder is not null) path.Text = folder.Path; };
        var panel = new StackPanel { Spacing = 12 }; panel.Children.Add(name); panel.Children.Add(path); panel.Children.Add(choose);
        panel.Children.Add(new TextBlock { Text = "请选择空文件夹，原始 Word 会保存在项目内。", TextWrapping = TextWrapping.Wrap, FontSize = 12 });
        var dialog = new ContentDialog { XamlRoot = Root.XamlRoot, Title = import ? "导入 Word" : "新建项目", Content = panel, PrimaryButtonText = import ? "导入" : "创建", CloseButtonText = "取消", DefaultButton = ContentDialogButton.Primary };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        if (string.IsNullOrWhiteSpace(path.Text) || string.IsNullOrWhiteSpace(name.Text)) throw new InvalidOperationException("请填写项目名称和文件夹。");
        var project = await _client.CreateProjectAsync(Path.GetFullPath(path.Text), name.Text, source is null ? null : await File.ReadAllBytesAsync(source.Path), source?.Name); await AdoptProjectAsync(project);
    }
    private async Task AddSectionAsync()
    {
        if (_session.Project is null) { Inform("请先打开项目。"); return; } await SaveAsync();
        var title = new TextBox { Header = "章节标题", Text = "新章节", MinWidth = 380 };
        var parent = new ComboBox { Header = "父章节", HorizontalAlignment = HorizontalAlignment.Stretch, DisplayMemberPath = "Title" }; parent.Items.Add(new LabelItem("", "无父章节"));
        foreach (var section in (_session.Project["sections"] as JsonArray ?? []).OfType<JsonObject>()) parent.Items.Add(new LabelItem(Str(section["id"]), Str(section["title"]))); parent.SelectedIndex = 0;
        var panel = new StackPanel { Spacing = 12 }; panel.Children.Add(title); panel.Children.Add(parent);
        if (await new ContentDialog { XamlRoot = Root.XamlRoot, Title = "新增章节", Content = panel, PrimaryButtonText = "添加", CloseButtonText = "取消" }.ShowAsync() != ContentDialogResult.Primary) return;
        var args = new JsonObject { ["expected_revision"] = Rev(_session.Project), ["title"] = title.Text };
        if (parent.SelectedItem is LabelItem { Id.Length: > 0 } selected) args["parent_id"] = selected.Id;
        var result = (await ProjectToolAsync("create_section", args)).AsObject(); var added = result["section"]?["id"]?.GetValue<string>() ?? (result["changedSections"] as JsonArray)!.Last()!["id"]!.GetValue<string>(); _session.ApplyEnvelope(result, true); await _session.SwitchSectionAsync(added); _editor.ResetHistory(); RenderProject(true);
    }
    private async Task EditSectionAsync()
    {
        if (_session.Project == null || _session.SectionId == null) { Inform("请先选择章节。"); return; }
        await SaveAsync(); var sectionId = _session.SectionId; var section = CurrentSection!;
        var title = new TextBox { Header = "章节标题", Text = Str(section["title"]), MinWidth = 380 };
        var parent = new ComboBox { Header = "父章节", HorizontalAlignment = HorizontalAlignment.Stretch };
        parent.Items.Add(new LabelItem("", "文档根目录"));
        foreach (var item in (_session.Project["sections"] as JsonArray ?? []).OfType<JsonObject>().Where(x => Str(x["id"]) != sectionId)) parent.Items.Add(new LabelItem(Str(item["id"]), Str(item["title"])));
        parent.SelectedItem = parent.Items.OfType<LabelItem>().FirstOrDefault(x => x.Id == Str(section["parentId"])) ?? parent.Items[0];
        var before = new ComboBox { Header = "放到哪个同级章节之前", HorizontalAlignment = HorizontalAlignment.Stretch };
        void LoadSiblingChoices()
        {
            var parentId = (parent.SelectedItem as LabelItem)?.Id ?? "";
            before.Items.Clear(); before.Items.Add(new LabelItem("", "保持当前位置（换父章节时放到末尾）"));
            foreach (var item in (_session.Project["sections"] as JsonArray ?? []).OfType<JsonObject>().Where(x => Str(x["id"]) != sectionId && Str(x["parentId"]) == parentId)) before.Items.Add(new LabelItem(Str(item["id"]), Str(item["title"])));
            before.SelectedIndex = 0;
        }
        parent.SelectionChanged += (_, _) => LoadSiblingChoices(); LoadSiblingChoices();
        var panel = new StackPanel { Spacing = 12 }; panel.Children.Add(title); panel.Children.Add(parent); panel.Children.Add(before);
        panel.Children.Add(new TextBlock { Text = "移动章节会同时移动它的子章节和内容。", TextWrapping = TextWrapping.Wrap });
        var delete = new Button { Content = "删除当前章节及子章节" }; panel.Children.Add(delete);
        var dialog = new ContentDialog { XamlRoot = Root.XamlRoot, Title = "章节组织", Content = panel, PrimaryButtonText = "保存", CloseButtonText = "取消" };
        bool deleting = false; delete.Click += (_, _) => { deleting = true; dialog.Hide(); };
        var answer = await dialog.ShowAsync();
        if (deleting)
        {
            if (await new ContentDialog { XamlRoot = Root.XamlRoot, Title = "删除章节", Content = "将删除所选章节、子章节及其正文。是否继续？", PrimaryButtonText = "删除", CloseButtonText = "取消" }.ShowAsync() != ContentDialogResult.Primary) return;
            var result = (await ProjectToolAsync("delete_section", new JsonObject { ["section_id"] = sectionId, ["expected_revision"] = Rev(section) })).AsObject();
            _session.ApplyEnvelope(result, true);
            if ((_session.Project["sections"] as JsonArray)?.FirstOrDefault() is JsonObject next) await _session.SwitchSectionAsync(Str(next["id"]));
        }
        else if (answer == ContentDialogResult.Primary)
        {
            if (title.Text != Str(section["title"]))
            {
                var updated = (await ProjectToolAsync("update_section", new JsonObject { ["section_id"] = sectionId, ["expected_revision"] = Rev(CurrentSection), ["title"] = title.Text })).AsObject();
                _session.ApplyEnvelope(updated, true);
            }
            var parentId = (parent.SelectedItem as LabelItem)?.Id ?? "";
            var beforeId = (before.SelectedItem as LabelItem)?.Id ?? "";
            if (parentId != Str(section["parentId"]) || beforeId.Length > 0)
            {
                var moved = (await ProjectToolAsync("move_section", new JsonObject { ["section_id"] = sectionId, ["expected_revision"] = Rev(CurrentSection), ["parent_id"] = parentId.Length == 0 ? null : parentId, ["before_id"] = beforeId.Length == 0 ? null : beforeId })).AsObject();
                _session.ApplyEnvelope(moved, true);
            }
        }
        else return;
        _editor.ResetHistory(); RenderProject();
    }
    private async Task ExportAsync()
    {
        if (_session.Project is null) { Inform("请先打开项目。"); return; } await SaveAsync(); if (_session.Conflicted) return;
        var range = new ComboBox { Header = "导出范围", MinWidth = 350 }; range.Items.Add("完整文档"); range.Items.Add("当前章节"); range.SelectedIndex = 0;
        var format = new ComboBox { Header = "文件格式", MinWidth = 350 }; format.Items.Add("Word 文档 (.docx)"); format.Items.Add("结构化内容包 (.zip)"); format.SelectedIndex = 0;
        var panel = new StackPanel { Spacing = 12 }; panel.Children.Add(range); panel.Children.Add(format);
        if (await new ContentDialog { XamlRoot = Root.XamlRoot, Title = "导出文档", Content = panel, PrimaryButtonText = "选择保存位置", CloseButtonText = "取消" }.ShowAsync() != ContentDialogResult.Primary) return;
        var kind = format.SelectedIndex == 0 ? "docx" : "zip";
        var file = await SavePicker(Str(_session.Project["title"], "文档"), "." + kind).PickSaveFileAsync(); if (file is null) return;
        await File.WriteAllBytesAsync(file.Path, await _client.ExportAsync(range.SelectedIndex == 1 && _session.SectionId is not null ? [_session.SectionId] : null, Str(_session.Project["id"]), kind)); Inform("文档已保存：" + file.Path);
    }
    private async Task ChooseImageAsync()
    {
        if (_session.Project is null) { Inform("请先打开项目。"); return; } var file = await FilePicker(".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp").PickSingleFileAsync(); if (file is not null) await InsertImageFileAsync(file.Path);
    }
    private async Task InsertImageFileAsync(string path)
    {
        if (_session.Project is null) return; var asset = await _client.AddAssetAsync(await File.ReadAllBytesAsync(path), Path.GetFileName(path), Str(_session.Project["id"]));
        var src = asset["src"]?.GetValue<string>() ?? asset["path"]?.GetValue<string>() ?? throw new IOException("图片资源没有返回项目路径");
        NativeAction(() => _editor.InsertImage(new JsonObject { ["type"] = "image", ["attrs"] = new JsonObject { ["id"] = Guid.NewGuid().ToString(), ["src"] = src, ["alt"] = Path.GetFileName(path) } }));
    }
    private async Task PasteImageAsync()
    {
        var data = Clipboard.GetContent();
        if (data.Contains(StandardDataFormats.StorageItems))
        {
            foreach (var item in await data.GetStorageItemsAsync()) if (item is StorageFile file && new[] { ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp" }.Contains(file.FileType.ToLowerInvariant())) await InsertImageFileAsync(file.Path);
        }
        else if (data.Contains(StandardDataFormats.Bitmap))
        {
            var bitmap = await data.GetBitmapAsync(); using var stream = await bitmap.OpenReadAsync();
            var bytes = new byte[checked((int)stream.Size)]; using var reader = new Windows.Storage.Streams.DataReader(stream); await reader.LoadAsync((uint)bytes.Length); reader.ReadBytes(bytes);
            var asset = await _client.AddAssetAsync(bytes, "剪贴板.png", Str(_session.Project?["id"])); var src = asset["src"]?.GetValue<string>() ?? asset["path"]?.GetValue<string>() ?? throw new IOException("图片资源路径缺失");
            NativeAction(() => _editor.InsertImage(new JsonObject { ["type"] = "image", ["attrs"] = new JsonObject { ["id"] = Guid.NewGuid().ToString(), ["src"] = src, ["alt"] = "剪贴板图片" } }));
        }
    }
    private async Task MoveBlockAsync()
    {
        if (_session.Project is null || _editor.SelectedRootId is not string id || MoveTarget.SelectedItem is not LabelItem target) return;
        await SaveAsync(); var sourceId = _session.SectionId!; var source = CurrentSection!; var destination = JsonData.FindSection(_session.Project, target.Id)!;
        var blocks = source["blocks"]!.AsArray(); var block = blocks.First(b => JsonData.Id(b) == id)!;
        var order = blocks.Select(JsonData.Id).ToArray(); var index = Array.IndexOf(order, id); var beforeId = index + 1 < order.Length ? order[index + 1] : null;
        var result = (await ProjectToolAsync("move_block", new JsonObject { ["block_id"] = id, ["expected_revision"] = Rev(block), ["section_id"] = target.Id, ["target_revision"] = Rev(destination) })).AsObject();
        var moved = (result["changedBlocks"] as JsonArray)?.FirstOrDefault(b => JsonData.Id(b) == id);
        _moveRedo.Clear(); _moveUndo.Push(new MoveHistory(id, sourceId, target.Id, beforeId, Rev(moved)));
        _session.ApplyEnvelope(result, true); _editor.ResetHistory(); RenderProject();
    }
    private void Undo()
    {
        if (_editor.CanUndo) NativeAction(_editor.Undo); else if (_moveUndo.Count > 0) Run(() => ExclusiveAsync(() => UndoMoveAsync(false)));
    }
    private void Redo()
    {
        if (_editor.CanRedo) NativeAction(_editor.Redo); else if (_moveRedo.Count > 0) Run(() => ExclusiveAsync(() => UndoMoveAsync(true)));
    }
    private async Task UndoMoveAsync(bool redo)
    {
        await SaveAsync(); var stack = redo ? _moveRedo : _moveUndo; if (stack.Count == 0 || _session.Project is null) return;
        var entry = stack.Peek(); var targetId = redo ? entry.TargetId : entry.SourceId;
        var destination = JsonData.FindSection(_session.Project, targetId) ?? throw new ServiceException("目标章节已被删除", 409);
        var args = new JsonObject { ["block_id"] = entry.BlockId, ["expected_revision"] = entry.BlockRevision, ["section_id"] = targetId, ["target_revision"] = Rev(destination) };
        if (!redo && entry.BeforeId != null) args["before_id"] = entry.BeforeId;
        var result = (await ProjectToolAsync("move_block", args)).AsObject();
        var moved = (result["changedBlocks"] as JsonArray)?.FirstOrDefault(b => JsonData.Id(b) == entry.BlockId);
        stack.Pop(); (redo ? _moveUndo : _moveRedo).Push(entry with { BlockRevision = Rev(moved) });
        _session.ApplyEnvelope(result, true); _editor.ResetHistory(); RenderProject();
    }
    private void InitializeStylesControls()
    {
        SemanticStyle.Items.Add(new LabelItem("body", "正文"));
        for (var level = 1; level <= 9; level++) SemanticStyle.Items.Add(new LabelItem("heading" + level, "标题 " + level));
        SemanticStyle.DisplayMemberPath = "Title"; SemanticStyle.SelectedIndex = 0;
        foreach (var label in new[] { "语义样式与页面", "完整导出模板" }) StyleScope.Items.Add(label); StyleScope.SelectedIndex = 0;
    }
    private void LoadStyles(bool force)
    {
        if (_session.Project?["styles"] is not JsonObject styles || (!force && (_styleDirty || _advancedDirty))) return;
        _styleDraft = styles.DeepClone().AsObject(); _styleOriginal = styles.DeepClone().AsObject(); _styleProjectId = Str(_session.Project["id"]); _styleRevision = Rev(_session.Project); RenderCommonStyle(); RenderAdvancedStyles();
    }
    private JsonObject SelectedSemanticRule()
    {
        var id = (SemanticStyle.SelectedItem as LabelItem)?.Id ?? "body";
        if (_styleDraft["semantic"] is not JsonObject semantic) _styleDraft["semantic"] = semantic = new JsonObject();
        // Source document uses headings as nested level keys.
        if (id.StartsWith("heading", StringComparison.Ordinal))
        {
            if (semantic["headings"] is not JsonObject headings) semantic["headings"] = headings = new JsonObject();
            var key = id[7..]; if (headings[key] is not JsonObject heading) {
                var level = int.Parse(key); headings[key] = heading = new JsonObject {
                    ["font"] = new JsonObject { ["eastAsia"] = "黑体", ["latin"] = "Calibri", ["sizePt"] = level == 1 ? 20 : level == 2 ? 16 : 14, ["bold"] = true },
                    ["paragraph"] = new JsonObject { ["beforePt"] = 12, ["afterPt"] = 6 }
                };
            } return heading;
        }
        if (semantic[id] is not JsonObject rule) semantic[id] = rule = new JsonObject {
            ["font"] = new JsonObject { ["eastAsia"] = "宋体", ["latin"] = "Calibri", ["sizePt"] = 12 },
            ["paragraph"] = new JsonObject { ["afterPt"] = 6, ["line"] = 360 }
        }; return rule;
    }
    private void RenderCommonStyle()
    {
        _styleRendering = true;
        try
        {
            var rule = SelectedSemanticRule(); var font = rule["font"]; var paragraph = rule["paragraph"];
            StyleFont.Text = Str(font?["eastAsia"], "宋体"); StyleLatinFont.Text = Str(font?["latin"], Str(font?["ascii"], "Calibri")); StyleSize.Value = Number(font?["sizePt"], 12); StyleBold.IsChecked = font?["bold"]?.GetValue<bool>() == true;
            StyleAlignment.SelectedIndex = new[] { "left", "center", "right", "both" }.ToList().IndexOf(Str(paragraph?["alignment"], "left"));
            var line = Number(paragraph?["line"], 240); StyleLine.SelectedIndex = Str(paragraph?["lineRule"], "auto") == "auto" ? Array.IndexOf(new[] { 240d, 360d, 480d }, line) : -1;
            StyleBefore.Value = Number(paragraph?["beforePt"], 0); StyleAfter.Value = Number(paragraph?["afterPt"], 0); StyleIndent.Value = Number(paragraph?["indent"]?["firstLine"], 0) / 20;
            _shownCommonStyle = CommonValues();
        }
        finally { _styleRendering = false; }
    }
    private static double Number(JsonNode? value, double fallback) => double.TryParse(value?.ToString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var number) && double.IsFinite(number) ? number : fallback;
    private CommonStyleValues CommonValues() => new(StyleFont.Text, StyleLatinFont.Text, StyleSize.Value, StyleBold.IsChecked == true, StyleAlignment.SelectedIndex, StyleLine.SelectedIndex, StyleBefore.Value, StyleAfter.Value, StyleIndent.Value);
    private void SetCommonStyle()
    {
        if (_styleRendering || !_ready || _session.Project is null) return;
        var value = CommonValues(); var shown = _shownCommonStyle; if (shown is null || value == shown) return;
        if (_advancedDirty) { Inform("请先保存详细样式，再修改常用样式。"); RenderCommonStyle(); return; }
        var rule = SelectedSemanticRule(); if (rule["font"] is not JsonObject font) rule["font"] = font = new JsonObject(); if (rule["paragraph"] is not JsonObject paragraph) rule["paragraph"] = paragraph = new JsonObject();
        if (value.Font != shown.Font && !string.IsNullOrWhiteSpace(value.Font)) font["eastAsia"] = value.Font.Trim();
        if (value.Latin != shown.Latin && !string.IsNullOrWhiteSpace(value.Latin)) font["latin"] = value.Latin.Trim();
        if (!value.Size.Equals(shown.Size) && double.IsFinite(value.Size)) font["sizePt"] = value.Size;
        if (value.Bold != shown.Bold) font["bold"] = value.Bold;
        if (value.Alignment != shown.Alignment && value.Alignment >= 0) paragraph["alignment"] = ((ComboBoxItem)StyleAlignment.SelectedItem).Tag.ToString();
        if (value.Line != shown.Line && value.Line >= 0) { paragraph["line"] = new[] { 240, 360, 480 }[value.Line]; paragraph["lineRule"] = "auto"; }
        if (!value.Before.Equals(shown.Before) && double.IsFinite(value.Before)) paragraph["beforePt"] = value.Before;
        if (!value.After.Equals(shown.After) && double.IsFinite(value.After)) paragraph["afterPt"] = value.After;
        if (!value.Indent.Equals(shown.Indent) && double.IsFinite(value.Indent)) { if (paragraph["indent"] is not JsonObject indent) paragraph["indent"] = indent = new JsonObject(); indent["firstLine"] = Math.Round(value.Indent * 20); indent.Remove("hanging"); }
        _shownCommonStyle = value; _styleDirty = true; RenderAdvancedStyles();
    }
    private void CommonStyle_Changed(object sender, TextChangedEventArgs e) => SetCommonStyle();
    private void StyleSize_ValueChanged(NumberBox sender, NumberBoxValueChangedEventArgs args) => SetCommonStyle();
    private void CommonStyle_Click(object sender, RoutedEventArgs e) => SetCommonStyle();
    private void CommonStyle_SelectionChanged(object sender, SelectionChangedEventArgs e) => SetCommonStyle();
    private void SemanticStyle_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (_ready) RenderCommonStyle(); }
    private void RenderAdvancedStyles()
    {
        _styleRendering = true;
        try
        {
            var value = StyleScope.SelectedIndex switch { 1 => _styleDraft, _ => new JsonObject { ["semantic"] = _styleDraft["semantic"]?.DeepClone(), ["pages"] = _styleDraft["pages"]?.DeepClone() } };
            StylesEditor.Text = value?.ToJsonString(_pretty) ?? "{}";
        }
        finally { _styleRendering = false; }
    }
    private void StyleScope_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_ready) return;
        if (_advancedDirty) { Inform("切换详细样式前请先保存；已将文本副本保留到本地草稿目录。"); try { Directory.CreateDirectory(Path.Combine(_client.RuntimeDirectory, "drafts")); File.WriteAllText(Path.Combine(_client.RuntimeDirectory, "drafts", "styles-" + DateTime.Now.ToString("yyyyMMdd-HHmmssfff") + ".json"), StylesEditor.Text); } catch (Exception ex) { ShowError(ex); return; } _advancedDirty = false; }
        RenderAdvancedStyles();
    }
    private void StylesEditor_TextChanged(object sender, TextChangedEventArgs e) { if (_ready && !_styleRendering) _advancedDirty = true; }
    private void SaveStyles_Click(object sender, RoutedEventArgs e) => Run(() => ExclusiveAsync(() => SaveStylesAsync(false)));
    private void SaveAdvancedStyles_Click(object sender, RoutedEventArgs e) => Run(() => ExclusiveAsync(() => SaveStylesAsync(true)));
    private async Task SaveStylesAsync(bool advanced)
    {
        if (_session.Project is null) return;
        if (_editor.IsComposing) throw new InvalidOperationException("请先完成当前文字输入，再应用样式。");
        if (!advanced && (string.IsNullOrWhiteSpace(StyleFont.Text) || string.IsNullOrWhiteSpace(StyleLatinFont.Text) || !double.IsFinite(StyleSize.Value))) throw new InvalidOperationException("请填写字体和有效字号。");
        if (_styleProjectId != Str(_session.Project["id"])) throw new InvalidOperationException("活动项目已改变，请重新读取当前项目样式后继续。");
        if (!advanced && _advancedDirty) throw new InvalidOperationException("详细样式还有未保存的输入，请先保存详细样式。");
        var original = _styleOriginal.DeepClone(); var captured = _styleDraft.DeepClone().AsObject();
        if (advanced)
        {
            var json = JsonNode.Parse(StylesEditor.Text) ?? throw new InvalidOperationException("样式内容为空。");
            if (StyleScope.SelectedIndex == 1) captured = json.AsObject();
            else { if (json is not JsonObject obj || obj["semantic"] is not JsonObject || obj["pages"] is not JsonArray) throw new InvalidOperationException("常用规则必须包含 semantic 对象和 pages 数组。"); captured["semantic"] = obj["semantic"]!.DeepClone(); captured["pages"] = obj["pages"]!.DeepClone(); }
        }
        StyleFont.IsEnabled = StyleSize.IsEnabled = StylesEditor.IsEnabled = SemanticStyle.IsEnabled = StyleScope.IsEnabled = false;
        try
        {
            await SaveAsync();
            if (_session.Conflicted) throw new ServiceException("请先处理正文草稿冲突，再应用样式。", 409);
            var current = await _client.GetProjectAsync() ?? throw new InvalidOperationException("当前项目已关闭。");
            if (Str(current["id"]) != Str(_session.Project?["id"]) || !JsonNode.DeepEquals(current["styles"], original))
            {
                var draftPath = Path.Combine(_client.RuntimeDirectory, "drafts", "styles-" + DateTime.Now.ToString("yyyyMMdd-HHmmssfff") + ".json"); Directory.CreateDirectory(Path.GetDirectoryName(draftPath)!); await File.WriteAllTextAsync(draftPath, captured.ToJsonString(_pretty));
                throw new ServiceException("样式已被其他编辑修改。本次设置仍保留，副本位于 " + draftPath, 409);
            }
            var result = (await ProjectToolAsync("styles", new JsonObject { ["expected_revision"] = Rev(current), ["styles"] = captured })).AsObject();
            _session.ApplyEnvelope(result, true);
            _styleDirty = _advancedDirty = false; LoadStyles(true); RenderProject(); Inform("样式已保存。");
        }
        finally { StyleFont.IsEnabled = StyleSize.IsEnabled = StylesEditor.IsEnabled = SemanticStyle.IsEnabled = StyleScope.IsEnabled = true; }
    }
    private void ExportPreset_Click(object sender, RoutedEventArgs e) => Run(ExportPresetAsync);
    private void ImportPreset_Click(object sender, RoutedEventArgs e) => Run(ImportPresetAsync);
    private async Task ExportPresetAsync()
    {
        if (_advancedDirty) throw new InvalidOperationException("请先保存详细样式，再导出预设。");
        if (_session.Project is null) return; var file = await SavePicker("文档样式预设", ".json").PickSaveFileAsync(); if (file is null) return;
        var preset = new JsonObject { ["formatVersion"] = 1, ["semantic"] = _styleDraft["semantic"]?.DeepClone(), ["pages"] = _styleDraft["pages"]?.DeepClone() }; await File.WriteAllTextAsync(file.Path, preset.ToJsonString(_pretty));
    }
    private async Task ImportPresetAsync()
    {
        if (_advancedDirty) throw new InvalidOperationException("请先保存详细样式，再导入预设。");
        if (_session.Project is null) return; var file = await FilePicker(".json").PickSingleFileAsync(); if (file is null) return;
        var preset = JsonNode.Parse(await File.ReadAllTextAsync(file.Path))?.AsObject() ?? throw new InvalidOperationException("预设格式不正确。");
        if (preset["semantic"] is not JsonObject || preset["pages"] is not JsonArray) throw new InvalidOperationException("预设须包含 semantic 和 pages。");
        _styleDraft["semantic"] = preset["semantic"]!.DeepClone(); _styleDraft["pages"] = preset["pages"]!.DeepClone(); _styleDirty = true; RenderCommonStyle(); RenderAdvancedStyles(); SelectInspector("style"); Inform("预设已加载，点击应用样式保存。");
    }
    private async Task PageSetupAsync()
    {
        if (_session.Project is null) return;
        if (_advancedDirty) throw new InvalidOperationException("请先保存详细样式，再设置页面。");
        var page = (_styleDraft["pages"] as JsonArray)?.FirstOrDefault() as JsonObject ?? new JsonObject(); var margins = page["margins"] as JsonObject;
        var panel = new StackPanel { Spacing = 10, MinWidth = 320 }; var values = new Dictionary<string, NumberBox>();
        foreach (var pair in new[] { ("top", "上边距"), ("bottom", "下边距"), ("left", "左边距"), ("right", "右边距") })
        {
            var box = new NumberBox { Header = pair.Item2 + "（毫米）", Minimum = 0, Maximum = 100, Value = double.TryParse(margins?[pair.Item1]?.ToString(), out var twips) ? twips * 25.4 / 1440 : 25.4, SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Compact };
            values[pair.Item1] = box; panel.Children.Add(box);
        }
        var orientation = new ComboBox { Header = "页面方向" }; orientation.Items.Add("纵向"); orientation.Items.Add("横向"); orientation.SelectedIndex = Str(page["size"]?["orient"]) == "landscape" ? 1 : 0; panel.Children.Add(orientation);
        if (await new ContentDialog { XamlRoot = Root.XamlRoot, Title = "页面设置", Content = panel, PrimaryButtonText = "应用到样式", CloseButtonText = "取消" }.ShowAsync() != ContentDialogResult.Primary) return;
        if (_styleDraft["pages"] is not JsonArray pages || pages.Count == 0) _styleDraft["pages"] = pages = new JsonArray(page);
        page = pages[0]!.AsObject(); if (page["margins"] is not JsonObject marginObject) page["margins"] = marginObject = new JsonObject();
        foreach (var (key, box) in values) marginObject[key] = Math.Round(box.Value * 1440 / 25.4).ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (page["size"] is not JsonObject size) page["size"] = size = new JsonObject { ["w"] = "11906", ["h"] = "16838" };
        var width = double.TryParse(size["w"]?.ToString(), out var w) ? w : 11906; var height = double.TryParse(size["h"]?.ToString(), out var h) ? h : 16838;
        size["w"] = (orientation.SelectedIndex == 1 ? Math.Max(width, height) : Math.Min(width, height)).ToString(); size["h"] = (orientation.SelectedIndex == 1 ? Math.Min(width, height) : Math.Max(width, height)).ToString(); size["orient"] = orientation.SelectedIndex == 1 ? "landscape" : "portrait";
        _styleDirty = true; RenderAdvancedStyles(); SelectInspector("style");
    }
    private async Task SaveDraftAsync()
    {
        if (_session.Project is null) return; var file = await SavePicker("本地编辑草稿", ".json").PickSaveFileAsync(); if (file is not null) { await File.WriteAllTextAsync(file.Path, _session.GetDraftJson()); _draftExported = true; }
    }
    private async Task ReloadConflictAsync()
    {
        if (_session.Dirty || _session.Conflicted)
        {
            if (await new ContentDialog { XamlRoot = Root.XamlRoot, Title = "读取已保存版本", Content = "当前输入仍保存在本地草稿。读取后将显示已保存的内容，建议先导出草稿。", PrimaryButtonText = "读取已保存版本", CloseButtonText = "取消", DefaultButton = ContentDialogButton.Close }.ShowAsync() != ContentDialogResult.Primary) return;
        }
        await _session.ReloadConflictAsync(); _editor.ResetHistory(); Notice.IsOpen = false; RenderProject(true);
    }
    private async Task ConflictDialogAsync()
    {
        var panel = new StackPanel { Spacing = 10 }; panel.Children.Add(new TextBlock { Text = "先保存草稿，再读取已保存版本。", TextWrapping = TextWrapping.Wrap });
        var save = new Button { Content = "保存本地草稿" }; save.Click += (_, _) => Run(SaveDraftAsync); panel.Children.Add(save);
        await new ContentDialog { XamlRoot = Root.XamlRoot, Title = "处理本地草稿", Content = panel, CloseButtonText = "返回编辑器" }.ShowAsync();
    }
    private async Task DialogAsync(string title, string text) => await new ContentDialog { XamlRoot = Root.XamlRoot, Title = title, Content = new ScrollViewer { Content = new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, MaxWidth = 620 }, MaxHeight = 500 }, CloseButtonText = "关闭" }.ShowAsync();
    private void Root_KeyDown(object sender, KeyRoutedEventArgs e)
    {
        var ctrl = Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Control).HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
        if (!ctrl) return;
        for (var source = e.OriginalSource as DependencyObject; source is not null; source = VisualTreeHelper.GetParent(source))
        {
            if (source != BlockList) continue;
            if (e.Key == VirtualKey.C) { e.Handled = true; Run(() => NativeClipboardActionAsync(_editor.CopySelectedBlocksToClipboardAsync)); return; }
            if (e.Key == VirtualKey.V) { e.Handled = true; Run(() => NativeClipboardActionAsync(_editor.PasteClipboardAsync)); return; }
            if (e.Key == VirtualKey.A)
            {
                e.Handled = true;
                NativeAction(() => _editor.SelectRoots(_session.Nodes.OfType<JsonObject>().Select(n => JsonData.Id(n)!).ToArray(), _editor.SelectedRootId));
                return;
            }
            break;
        }
        if (e.Key == VirtualKey.S) { e.Handled = true; Run(SaveAsync); }
        else if (e.Key == VirtualKey.Z) { e.Handled = true; if (Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Shift).HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down)) Redo(); else Undo(); }
        else if (e.Key == VirtualKey.Y) { e.Handled = true; Redo(); }
        else if (e.Key == VirtualKey.B) { e.Handled = true; Command("bold"); }
        else if (e.Key == VirtualKey.I) { e.Handled = true; Command("italic"); }
    }
    private async void AppWindow_Closing(AppWindow sender, AppWindowClosingEventArgs args)
    {
        if (_allowClose) return; args.Cancel = true; if (_closing) return; _closing = true; _poll.Stop(); _autoSave.Stop();
        try
        {
            if (_editor.IsComposing) throw new InvalidOperationException("请先完成正在输入的文字，再关闭文档。");
            await SaveAsync();
            if (_session.DraftPersistenceError is not null && (_session.Dirty || _session.Conflicted) && !_draftExported) throw new IOException("本地草稿尚未成功写入。请先导出草稿，再关闭文档。");
            if (_session.Conflicted || _styleDirty || _advancedDirty)
            {
                var result = await new ContentDialog { XamlRoot = Root.XamlRoot, Title = "还有未提交内容", Content = _session.Conflicted ? "输入已保留为本地草稿，关闭后仍可恢复。" : "正文已保存，样式设置尚未提交。", PrimaryButtonText = "关闭", CloseButtonText = "继续编辑", DefaultButton = ContentDialogButton.Close }.ShowAsync();
                if (result != ContentDialogResult.Primary) return;
            }
            _allowClose = true; Close();
        }
        catch (Exception ex) { ShowError(ex); }
        finally { _closing = false; if (!_allowClose) _poll.Start(); }
    }
    private void WriteDiagnostics()
    {
        if (string.IsNullOrWhiteSpace(_diagnosticPath)) return;
        try
        {
            var json = new JsonObject { ["ui"] = "native-winui3", ["sectionId"] = _session.SectionId, ["dirty"] = _session.Dirty, ["conflicted"] = _session.Conflicted, ["selectedBlockId"] = _editor.SelectedRootId, ["selectedNodeId"] = _editor.SelectedNodeId, ["selectedCells"] = new JsonArray(_editor.SelectedCellIds.Select(x => JsonValue.Create(x) as JsonNode).ToArray()), ["blockIds"] = new JsonArray(_session.Nodes.Select(n => JsonValue.Create(JsonData.Id(n)) as JsonNode).ToArray()), ["status"] = StatusText.Text, ["projectRevision"] = Rev(_session.Project), ["projectId"] = _session.Project?["id"]?.DeepClone(), ["projectPath"] = CurrentProjectPath, ["canUndo"] = _editor.CanUndo, ["canRedo"] = _editor.CanRedo, ["styleDirty"] = _styleDirty || _advancedDirty, ["notice"] = Notice.IsOpen ? Notice.Message : null };
            json["rootComparisonCount"] = _editor.RootComparisonCount;
            json["view"] = _showHome ? "home" : "editor"; json["projectTitle"] = ProjectTitle.Text; json["projectListCount"] = RecentProjects.Items.Count;
            json["formatting"] = _editor.FormattingSnapshots;
            json["selectedBlockIds"] = new JsonArray(_editor.SelectedBlockIds.Select(x => JsonValue.Create(x) as JsonNode).ToArray());
            json["editingCellId"] = _editor.EditingCellId;
            json["activeTextEditorCount"] = _editor.ActiveTextEditorCount; json["tableCellCount"] = _editor.TableCellCount;
            json["imageCount"] = _editor.ImageCount; json["loadedImageCount"] = _editor.LoadedImageCount; json["failedImages"] = new JsonArray(_editor.FailedImages.Select(x => JsonValue.Create(x) as JsonNode).ToArray());
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(_diagnosticPath))!); var temp = _diagnosticPath + ".tmp"; File.WriteAllText(temp, json.ToJsonString(_pretty)); File.Move(temp, _diagnosticPath, true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }
}
