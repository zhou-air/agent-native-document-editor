using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.Json.Nodes;
using AgentDocument.Client;

var workspace = Path.GetFullPath(args.FirstOrDefault() ?? Path.Combine(AppContext.BaseDirectory, "../../../../.."));
var root = Path.Combine(workspace, "artifacts", "native-v2", DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N")[..8]);
Directory.CreateDirectory(root);
var results = new JsonArray(); int assertions = 0;
void Assert(bool value, string message) { assertions++; if (!value) throw new InvalidOperationException(message); }
async Task Check(string name, Func<Task> test)
{
    var clock = Stopwatch.StartNew();
    try { await test(); results.Add(new JsonObject { ["name"] = name, ["status"] = "passed", ["elapsedMs"] = clock.Elapsed.TotalMilliseconds }); Console.WriteLine("PASS " + name); }
    catch (Exception e) { results.Add(new JsonObject { ["name"] = name, ["status"] = "failed", ["error"] = e.ToString() }); throw; }
}
long Rev(JsonNode? n) => n?["revision"]?.GetValue<long>() ?? 0;
void Edit(EditorSession session, string id, string text)
{
    var node = session.Nodes.First(n => JsonData.Id(n) == id)!.DeepClone().AsObject();
    node["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = text });
    session.SetChangedNodes(new JsonArray(node), session.Nodes.Select(n => JsonData.Id(n)!).ToArray());
}
async Task Conflict(Func<Task> action)
{
    try { await action(); throw new InvalidOperationException("Expected conflict"); }
    catch (ServiceException e) when (e.StatusCode == 409) { assertions++; }
}
var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); var port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop();
var runtime = Path.Combine(root, "runtime"); var host = await ServiceHost.StartAsync(workspace, runtime, port);
using var client = new ControlledClient(workspace, runtime, port);
try
{
    await client.ConnectAsync();
    var manifest = await client.CreateProjectAsync(Path.Combine(root, "project"), "结构化增量客户端验收");
    var session = new EditorSession(client); await session.LoadProjectAsync(manifest);
    var sectionId = session.SectionId!; var firstId = JsonData.Id(session.Nodes[1])!;
    async Task<JsonObject> Read(string id) => (await client.ToolAsync("read_block", new JsonObject { ["block_id"] = id })).AsObject();
    async Task Remote(string id, string text)
    {
        var block = await Read(id); var node = block["node"]!.DeepClone().AsObject(); node["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = text });
        await client.ToolAsync("update_block", new JsonObject { ["block_id"] = id, ["expected_revision"] = Rev(block), ["node"] = node });
    }
    await Check("manifest_and_lazy_section_load", () =>
    {
        Assert(manifest["formatVersion"]!.GetValue<int>() == 2, "v2 manifest");
        Assert(manifest["sections"]!.AsArray().All(s => s?["blocks"] == null), "manifest has no block bodies");
        Assert(session.Nodes.Count == 2 && client.Calls.Count(c => c == "read_section") == 1, "only selected section fetched");
        return Task.CompletedTask;
    });
    await Check("single_block_save_is_partial_and_identity_stable", async () =>
    {
        Edit(session, firstId, "只修改这一个自然段。"); await session.SaveAsync();
        Assert(client.LastSaveArgs?["nodes"] == null && client.LastSaveArgs?["order"] == null, "ordinary content edit sends neither section nor structure");
        Assert(client.LastSaveArgs!["changed"]!.AsArray().Count == 1, "one changed block");
        Assert(JsonData.Text((await Read(firstId))["node"]) == "只修改这一个自然段。" && !session.Dirty, "save retained ID/content");
        Assert(session.Project!["sections"]!.AsArray().All(s => s?["blocks"] == null), "no full project materialized after save");
    });
    string secondId = "";
    await Check("atomic_structure_save_maps_server_created_ids", async () =>
    {
        var addition = JsonData.NewParagraph("第二个独立自然段"); var temporary = JsonData.Id(addition)!;
        var order = session.Nodes.Select(n => JsonData.Id(n)!).Append(temporary).ToArray();
        session.SetChangedNodes(new JsonArray(addition), order); await session.SaveAsync();
        secondId = session.PendingIdMappings[temporary];
        Assert(secondId != temporary && JsonData.Id(session.Nodes[^1]) == secondId, "service assigns authoritative UUID and remaps local buffer");
        Assert(!session.Dirty && client.LastSaveArgs!["created"]!.AsArray().Count == 1, "atomic structural commit clears dirty");
    });
    await Check("saved_delete_undo_restore_keeps_block_uuid", async () =>
    {
        var original = session.Nodes.First(n => JsonData.Id(n) == secondId)!.DeepClone();
        session.SetChangedNodes([], session.Nodes.Select(n => JsonData.Id(n)!).Where(id => id != secondId).ToArray()); await session.SaveAsync();
        Assert(session.Nodes.All(n => JsonData.Id(n) != secondId), "delete saved");
        session.SetChangedNodes(new JsonArray(original), session.Nodes.Select(n => JsonData.Id(n)!).Append(secondId).ToArray()); await session.SaveAsync();
        Assert(JsonData.Id(session.Nodes[^1]) == secondId && JsonData.Id(await Read(secondId)) == secondId, "restoration retains stable UUID");
        Assert(client.LastSaveArgs!["created"]![0]!["restore_id"]!.GetValue<string>() == secondId, "only own deletion restoration uses tombstone revision");
    });
    await Check("independent_remote_block_and_local_dirty_merge", async () =>
    {
        Edit(session, firstId, "本地待保存 A"); await Remote(secondId, "Agent 已保存 B"); await session.RefreshAsync();
        Assert(session.Dirty && !session.Conflicted, "independent external update merged");
        Assert(session.BlockText(firstId) == "本地待保存 A" && session.BlockText(secondId) == "Agent 已保存 B", "both contents retained");
        await session.SaveAsync(); Assert(JsonData.Text((await Read(secondId))["node"]) == "Agent 已保存 B", "saving A cannot overwrite B");
    });
    await Check("same_block_conflict_preserves_draft_and_server", async () =>
    {
        Edit(session, firstId, "本地冲突草稿"); await Remote(firstId, "外部同块新版本"); await Conflict(session.RefreshAsync);
        Assert(session.Conflicted && session.BlockText(firstId) == "本地冲突草稿", "local buffer survives conflict");
        var draft = JsonNode.Parse(session.GetDraftJson())!;
        Assert(draft["nodes"] == null && draft["base"] == null && draft["changed"]!.AsArray().Count == 1, "draft contains changed block only");
        await session.ReloadConflictAsync(); Assert(session.BlockText(firstId) == "外部同块新版本", "explicit reload selects server");
    });
    await Check("new_input_during_save_and_remote_change_survive", async () =>
    {
        Edit(session, firstId, "第一次保存输入"); client.HoldNextSave(); var saving = session.SaveAsync(); await client.SaveResponseHeld;
        Edit(session, firstId, "保存进行期间继续输入"); await Remote(secondId, "保存期间 Agent 修改 B"); client.ReleaseSave(); await saving; await session.RefreshAsync();
        Assert(JsonData.Text((await Read(firstId))["node"]) == "保存进行期间继续输入", "late input committed after first response");
        Assert(session.BlockText(secondId) == "保存期间 Agent 修改 B", "change cursor did not skip unrelated commit");
    });
    string otherSection = "";
    await Check("other_section_change_never_fetches_its_content", async () =>
    {
        var current = await client.GetProjectAsync();
        var created = (await client.ToolAsync("create_section", new JsonObject { ["title"] = "后台章节", ["expected_revision"] = Rev(current) })).AsObject();
        otherSection = created["section"]!["id"]!.GetValue<string>(); await session.RefreshAsync();
        var reads = client.Calls.Count(c => c == "read_section");
        var heading = created["section"]!["headingBlockId"]!.GetValue<string>(); await Remote(heading, "后台章节改名"); await session.RefreshAsync();
        Assert(client.Calls.Count(c => c == "read_section") == reads, "offscreen update did not read section");
        Assert(JsonData.FindSection(session.Project, otherSection)!["title"]!.GetValue<string>() == "后台章节改名", "navigation updated by section summary");
        Assert(session.Nodes.All(n => JsonData.Id(n) != heading), "offscreen body is not mounted");
        Assert(client.LastChanges!["changes"]!.AsArray().All(c => c!["changedBlocks"]!.AsArray().Count == 0), "offscreen body is not transmitted");
    });
    await Check("external_delete_of_dirty_block_preserves_input", async () =>
    {
        Edit(session, secondId, "正在编辑即使外部删除也保留"); var block = await Read(secondId);
        await client.ToolAsync("delete_block", new JsonObject { ["block_id"] = secondId, ["expected_revision"] = Rev(block) }); await Conflict(session.RefreshAsync);
        Assert(session.Nodes.Any(n => JsonData.Id(n) == secondId) && session.DirtyBlockIds.Contains(secondId), "dirty deleted block retained locally");
        Assert(session.GetDraftJson().Contains("正在编辑即使外部删除也保留") || JsonData.Text(JsonNode.Parse(session.GetDraftJson())!["changed"]![0]!["node"]) == "正在编辑即使外部删除也保留", "draft retains text");
        await session.ReloadConflictAsync();
    });
    await Check("external_move_of_dirty_block_preserves_input", async () =>
    {
        Edit(session, firstId, "正在编辑即使外部移动也保留"); var block = await Read(firstId); var target = (await client.ToolAsync("read_section", new JsonObject { ["section_id"] = otherSection })).AsObject();
        await client.ToolAsync("move_block", new JsonObject { ["block_id"] = firstId, ["expected_revision"] = Rev(block), ["section_id"] = otherSection, ["target_revision"] = Rev(target) });
        await Conflict(session.RefreshAsync); Assert(session.BlockText(firstId) == "正在编辑即使外部移动也保留" && session.DirtyBlockIds.Contains(firstId), "moved dirty block retained");
        await session.ReloadConflictAsync();
    });
    await Check("idle_refresh_has_no_content_or_changes_requests", async () =>
    {
        var calls = client.Calls.Count; var generation = session.ContentGeneration;
        for (int i = 0; i < 10; i++) await session.RefreshAsync();
        Assert(client.Calls.Count == calls && session.ContentGeneration == generation, "idle polls read revision only");
    });
    await Check("section_switch_reloads_only_requested_body", async () =>
    {
        var calls = client.Calls.Count(c => c == "read_section"); await session.SwitchSectionAsync(otherSection);
        Assert(session.SectionId == otherSection && session.Nodes.Any(n => JsonData.Id(n) == firstId), "moved block is in target with same ID");
        Assert(client.Calls.Count(c => c == "read_section") == calls + 1, "one selected section read");
    });
    await Check("draft_recovery_requires_explicit_resolution", async () =>
    {
        Edit(session, firstId, "重启恢复的未保存草稿"); var recovered = new EditorSession(client); await recovered.LoadProjectAsync((await client.GetProjectAsync())!); await recovered.SwitchSectionAsync(otherSection);
        Assert(recovered.Conflicted && recovered.BlockText(firstId) == "重启恢复的未保存草稿", "draft restored with conflict protection");
        await recovered.ReloadConflictAsync();
    });
}
finally
{
    await host.StopAsync();
    var report = new JsonObject { ["suite"] = "Native.Client.IncrementalV2", ["assertions"] = assertions, ["tests"] = results, ["root"] = root };
    var destination = Path.Combine(root, "client-results.json"); await File.WriteAllTextAsync(destination, report.ToJsonString(new JsonSerializerOptions { WriteIndented = true })); Console.WriteLine(destination);
}

sealed class ControlledClient(string workspace, string runtime, int port) : ServiceClient(workspace, runtime, port)
{
    private bool _hold;
    private TaskCompletionSource _held = new(TaskCreationOptions.RunContinuationsAsynchronously), _release = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public Task SaveResponseHeld => _held.Task.WaitAsync(TimeSpan.FromSeconds(20));
    public JsonObject? LastChanges { get; private set; }
    public JsonObject? LastSaveArgs { get; private set; }
    public List<string> Calls { get; } = [];
    public void HoldNextSave() { _hold = true; _held = new(TaskCreationOptions.RunContinuationsAsynchronously); _release = new(TaskCreationOptions.RunContinuationsAsynchronously); }
    public void ReleaseSave() => _release.TrySetResult();
    public override async Task<JsonNode> ToolAsync(string name, JsonObject args)
    {
        Calls.Add(name); if (name == "save_blocks") LastSaveArgs = args.DeepClone().AsObject();
        var result = await base.ToolAsync(name, args);
        if (name == "get_changes") LastChanges = result.DeepClone().AsObject();
        if (name == "save_blocks" && _hold) { _hold = false; _held.TrySetResult(); await _release.Task.WaitAsync(TimeSpan.FromSeconds(20)); }
        return result;
    }
}

