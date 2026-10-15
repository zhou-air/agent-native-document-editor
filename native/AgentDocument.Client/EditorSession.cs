using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgentDocument.Client;

/// <summary>Current-section cache with block revision checks and incremental service synchronization.</summary>
public sealed class EditorSession(ServiceClient client)
{
    private readonly SemaphoreSlim _saveGate = new(1, 1);
    private readonly Dictionary<string, JsonObject> _baseBlocks = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> _restoreMap = new(StringComparer.Ordinal);
    private readonly HashSet<string> _ownChanges = new(StringComparer.Ordinal);
    private readonly HashSet<string> _dirtyIds = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _textCache = new(StringComparer.Ordinal);
    public string BlockText(string? id) => id != null ? _textCache.GetValueOrDefault(id, "") : "";
    public int CharacterCount => _textCache.Values.Sum(t => t.Length);
    private bool _saving;
    private bool _structural;
    private long _cursor;
    private long _editGeneration;
    public JsonObject? Project { get; private set; }
    public string? SectionId { get; private set; }
    public JsonArray Nodes { get; private set; } = [];
    public JsonObject? BaseSection { get; private set; }
    public bool Dirty => _structural || _dirtyIds.Count > 0;
    public bool Conflicted { get; private set; }
    public string? DraftPersistenceError { get; private set; }
    public long ContentGeneration { get; private set; }
    public long TreeGeneration { get; private set; }
    public long StyleGeneration { get; private set; }
    public event EventHandler? Changed;
    public IReadOnlyCollection<string> DirtyBlockIds => _dirtyIds;
    public HashSet<string> PendingRenderBlockIds { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, string> PendingIdMappings { get; } = new(StringComparer.Ordinal);
    private static long Revision(JsonNode? n) => n?["revision"]?.GetValue<long>() ?? 0;
    private static string[] Ids(JsonArray nodes) => nodes.Select(JsonData.Id).Where(x => x != null).Cast<string>().ToArray();
    private static JsonArray Blocks(JsonObject? section) => section?["blocks"] as JsonArray ?? [];
    private JsonObject ProjectArgs() => new() { ["project_id"] = Project?["id"]?.DeepClone() };

    // Kept for callers that already own a section payload. New frontends use LoadProjectAsync.
    public void SetProject(JsonObject project)
    {
        Project = project.DeepClone().AsObject();
        _cursor = Revision(Project); _ownChanges.Clear(); _restoreMap.Clear(); PendingIdMappings.Clear(); PendingRenderBlockIds.Clear();
        var section = JsonData.FindSection(Project, SectionId) ?? (Project["sections"] as JsonArray)?.OfType<JsonObject>().FirstOrDefault();
        SectionId = section?["id"]?.GetValue<string>();
        Mount(section, section?["blocks"] is JsonArray);
        TreeGeneration++; StyleGeneration++;
    }

    public async Task LoadProjectAsync(JsonObject project)
    {
        SetProject(project);
        if (SectionId != null && BaseSection?["blocks"] is not JsonArray) await LoadSectionAsync(SectionId, true);
    }

    private void Mount(JsonObject? section, bool restore)
    {
        SectionId = section?["id"]?.GetValue<string>();
        BaseSection = section?.DeepClone().AsObject();
        Nodes = section is null ? [] : JsonData.NodesOf(section);
        _textCache.Clear(); foreach (var n in Nodes) _textCache[JsonData.Id(n)!] = JsonData.Text(n);
        _baseBlocks.Clear();
        foreach (var block in Blocks(BaseSection).OfType<JsonObject>()) _baseBlocks[JsonData.Id(block)!] = block;
        _dirtyIds.Clear(); _structural = false; Conflicted = false;
        ContentGeneration++;
        if (restore) RestoreDraft();
        Changed?.Invoke(this, EventArgs.Empty);
    }

    private async Task LoadSectionAsync(string id, bool restore)
    {
        var args = ProjectArgs(); args["section_id"] = id;
        var section = (await client.ToolAsync("read_section", args)).AsObject();
        Mount(section, restore);
    }

    public async Task EnsureSectionLoadedAsync()
    {
        if (SectionId != null && BaseSection?["blocks"] is not JsonArray) await LoadSectionAsync(SectionId, true);
    }

    public async Task SwitchSectionAsync(string id)
    {
        if (id == SectionId && BaseSection?["blocks"] is JsonArray) return;
        await SaveAsync();
        if (Conflicted) throw new ServiceException("请先处理当前章节冲突，草稿已保留。", 409);
        if (JsonData.FindSection(Project, id) == null) throw new ServiceException("章节不存在", 404);
        await LoadSectionAsync(id, true);
    }

    public void SetNodes(JsonArray nodes)
    {
        // Compatibility path used by import/paste callers; ordinary typing supplies only changed roots.
        JsonData.EnsureIds(nodes);
        var changed = nodes.Where(n => !JsonNode.DeepEquals(n, Nodes.FirstOrDefault(o => JsonData.Id(o) == JsonData.Id(n))));
        SetChangedNodes(new JsonArray(changed.Select(n => n?.DeepClone()).ToArray()), Ids(nodes));
    }

    public void SetChangedNodes(JsonArray changed, IReadOnlyList<string> order)
    {
        if (Project == null || BaseSection == null) throw new InvalidOperationException("请先打开项目和章节");
        var positions = Nodes.Select((n, i) => (id: JsonData.Id(n), i)).Where(x => x.id != null).ToDictionary(x => x.id!, x => x.i);
        foreach (var node in changed.OfType<JsonObject>())
        {
            var id = JsonData.Id(node) ?? throw new InvalidOperationException("内容块缺少 ID");
            _textCache[id] = JsonData.Text(node);
            var clone = node.DeepClone();
            if (positions.TryGetValue(id, out var i)) Nodes[i] = clone; else Nodes.Add(clone);
            if (_baseBlocks.TryGetValue(id, out var old) && JsonNode.DeepEquals(old["node"], node)) _dirtyIds.Remove(id); else _dirtyIds.Add(id);
        }
        if (!Ids(Nodes).SequenceEqual(order))
        {
            var byId = Nodes.OfType<JsonObject>().ToDictionary(n => JsonData.Id(n)!);
            Nodes.Clear();
            foreach (var id in order) if (byId.TryGetValue(id, out var n)) Nodes.Add(n);
        }
        var current = order.ToHashSet(); _dirtyIds.RemoveWhere(id => !current.Contains(id));
        foreach (var id in _textCache.Keys.Where(id => !current.Contains(id)).ToArray()) _textCache.Remove(id);
        _structural = !Blocks(BaseSection).Select(JsonData.Id).SequenceEqual(order);
        _editGeneration++; ContentGeneration++;
        if (Dirty || Conflicted) KeepDraft(); else RemoveDraft();
        Changed?.Invoke(this, EventArgs.Empty);
    }

    public async Task SaveAsync()
    {
        await _saveGate.WaitAsync();
        try
        {
            _saving = true;
            await EnsureSectionLoadedAsync();
            while (Dirty && !Conflicted && Project != null && BaseSection != null && SectionId != null)
            {
                var projectId = Project["id"]!.GetValue<string>(); var sectionId = SectionId;
                var generation = _editGeneration;
                var captured = _dirtyIds.Select(id => Nodes.FirstOrDefault(n => JsonData.Id(n) == id)).OfType<JsonObject>()
                    .ToDictionary(n => JsonData.Id(n)!, n => n.DeepClone().AsObject());
                var args = ProjectArgs(); args["section_id"] = sectionId;
                const string tool = "save_blocks";
                args["changed"] = new JsonArray(captured.Where(p => _baseBlocks.ContainsKey(p.Key)).Select(p => (JsonNode)new JsonObject { ["block_id"] = p.Key, ["expected_revision"] = Revision(_baseBlocks[p.Key]), ["node"] = p.Value.DeepClone() }).ToArray());
                if (_structural)
                {
                    args["order"] = new JsonArray(Ids(Nodes).Select(id => JsonValue.Create(id) as JsonNode).ToArray());
                    args["base_ids"] = new JsonArray(Blocks(BaseSection).Select(b => JsonValue.Create(JsonData.Id(b)) as JsonNode).ToArray());
                    args["section_revision"] = Revision(BaseSection);
                    args["created"] = new JsonArray(captured.Where(p => !_baseBlocks.ContainsKey(p.Key)).Select(p =>
                    {
                        var creation = new JsonObject { ["temporary_id"] = p.Key, ["node"] = p.Value.DeepClone() };
                        if (_restoreMap.TryGetValue(p.Key, out var deletedRevision)) { creation["restore_id"] = p.Key; creation["expected_deleted_revision"] = deletedRevision; }
                        return (JsonNode)creation;
                    }).ToArray());
                    var ids = Ids(Nodes).ToHashSet();
                    args["deleted"] = new JsonArray(_baseBlocks.Where(p => !ids.Contains(p.Key)).Select(p => (JsonNode)new JsonObject { ["block_id"] = p.Key, ["expected_revision"] = Revision(p.Value) }).ToArray());
                }
                try
                {
                    var result = (await client.ToolAsync(tool, args)).AsObject();
                    if (Project?["id"]?.GetValue<string>() != projectId || SectionId != sectionId) return;
                    if (_structural && generation == _editGeneration) _structural = false;
                    ApplyEnvelope(result, own: true, captured);
                    if (Dirty) KeepDraft(); else RemoveDraft();
                }
                catch (ServiceException e) when (e.StatusCode == 409) { MarkConflict(e.Message); }
            }
        }
        finally { _saving = false; _saveGate.Release(); Changed?.Invoke(this, EventArgs.Empty); }
    }

    public void ApplyEnvelope(JsonObject envelope, bool own = false, Dictionary<string, JsonObject>? captured = null)
    {
        if (Project == null) return;
        if (own && envelope["changeId"]?.GetValue<string>() is string changeId) _ownChanges.Add(changeId);
        // Legacy response compatibility is restricted to older local services.
        if (envelope["sections"] is JsonArray && envelope["id"] != null) { SetProject(envelope); return; }
        if (envelope["idMap"] is JsonObject { Count: > 0 } idMap)
        {
            foreach (var entry in idMap)
            {
                var newId = entry.Value!.GetValue<string>();
                if (entry.Key == newId) continue;
                PendingIdMappings[entry.Key] = newId;
                if (_textCache.Remove(entry.Key, out var text)) _textCache[newId] = text;
                var local = Nodes.FirstOrDefault(n => JsonData.Id(n) == entry.Key);
                if (local?["attrs"] is JsonObject attrs) attrs["id"] = newId;
                if (_dirtyIds.Remove(entry.Key)) _dirtyIds.Add(newId);
                if (captured != null && captured.Remove(entry.Key, out var sent))
                { if (sent["attrs"] is JsonObject sentAttrs) sentAttrs["id"] = newId; captured[newId] = sent; }
            }
            ContentGeneration++;
        }
        if (own && envelope["deletedBlockRevisions"] is JsonObject deletedRevisions)
            foreach (var entry in deletedRevisions) _restoreMap[entry.Key] = entry.Value!.GetValue<long>();
        bool contentChanged = false;
        foreach (var remote in (envelope["changedBlocks"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var id = JsonData.Id(remote)!; var remoteSection = remote["sectionId"]?.GetValue<string>();
            var local = Nodes.FirstOrDefault(n => JsonData.Id(n) == id);
            if (!own && _dirtyIds.Contains(id) && _baseBlocks.TryGetValue(id, out var baseline) && Revision(remote) != Revision(baseline) && !JsonNode.DeepEquals(local, remote["node"]))
                MarkConflict("同一内容块存在并发修改，本地草稿已保留。");
            if (remoteSection != SectionId)
            {
                if (!own && local != null && _dirtyIds.Contains(id)) MarkConflict("正在编辑的内容块已被其他客户端移动，草稿已保留。");
                if (local != null) { Nodes.Remove(local); _textCache.Remove(id); _baseBlocks.Remove(id); RemoveBaseBlock(id); contentChanged = true; }
                continue;
            }
            var block = remote.DeepClone().AsObject();
            ReplaceBaseBlock(block);
            if (own && captured != null && captured.TryGetValue(id, out var sent) && JsonNode.DeepEquals(local, sent)) _dirtyIds.Remove(id);
            if (!_dirtyIds.Contains(id))
            {
                var node = remote["node"]?.DeepClone();
                if (node != null && !JsonNode.DeepEquals(local, node))
                { if (local != null) Nodes[Nodes.IndexOf(local)] = node; else Nodes.Add(node); _textCache[id] = JsonData.Text(node); PendingRenderBlockIds.Add(id); contentChanged = true; }
            }
        }
        foreach (var value in envelope["removedFromSectionBlockIds"] as JsonArray ?? [])
        {
            var id = value?.GetValue<string>(); if (id == null) continue;
            if (_dirtyIds.Contains(id)) MarkConflict("正在编辑的内容块已被其他客户端移动，草稿已保留。");
            var local = Nodes.FirstOrDefault(n => JsonData.Id(n) == id); if (local != null) { Nodes.Remove(local); contentChanged = true; }
            _textCache.Remove(id); _baseBlocks.Remove(id); RemoveBaseBlock(id);
        }
        foreach (var value in envelope["deletedBlockIds"] as JsonArray ?? [])
        {
            var id = value?.GetValue<string>(); if (id == null) continue;
            if (!own && _dirtyIds.Contains(id)) MarkConflict("正在编辑的内容块已被其他客户端删除，草稿已保留。");
            var local = Nodes.FirstOrDefault(n => JsonData.Id(n) == id); if (local != null) { Nodes.Remove(local); contentChanged = true; }
            _dirtyIds.Remove(id); _textCache.Remove(id); _baseBlocks.Remove(id); RemoveBaseBlock(id);
        }
        var summaries = Project["sections"] as JsonArray ?? [];
        foreach (var section in (envelope["changedSections"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var id = section["id"]!.GetValue<string>(); var previous = JsonData.FindSection(Project, id);
            if (!own && previous != null && Revision(previous) > Revision(section)) continue;
            bool navigationChanged = previous == null || new[] { "title", "parentId", "order", "level" }.Any(k => !JsonNode.DeepEquals(previous[k], section[k]));
            if (previous == null) summaries.Add(section.DeepClone()); else foreach (var p in section) previous[p.Key] = p.Value?.DeepClone();
            if (navigationChanged) TreeGeneration++;
            if (id == SectionId && BaseSection != null)
            {
                if (!own && _structural && Revision(section) != Revision(BaseSection)) MarkConflict("章节结构存在并发修改，本地草稿已保留。");
                foreach (var p in section) if (p.Key != "blocks") BaseSection[p.Key] = p.Value?.DeepClone();
            }
        }
        foreach (var value in envelope["deletedSectionIds"] as JsonArray ?? [])
        {
            var id = value?.GetValue<string>(); var section = JsonData.FindSection(Project, id);
            if (id == SectionId && Dirty) MarkConflict("当前章节已被移除，草稿已保留。");
            if (section != null) { summaries.Remove(section); TreeGeneration++; }
            if (id == SectionId) { Mount(null, false); contentChanged = true; }
        }
        if (BaseSection != null && !_structural)
        {
            var orderMap = (BaseSection["blockIds"] as JsonArray)?.Select((v, i) => (id: v!.GetValue<string>(), i)).ToDictionary(x => x.id, x => x.i);
            var ordered = Blocks(BaseSection).OfType<JsonObject>().OrderBy(b => orderMap?.GetValueOrDefault(JsonData.Id(b)!, int.MaxValue) ?? b["order"]?.GetValue<double>() ?? 0).ToArray();
            var baseBlocks = Blocks(BaseSection); baseBlocks.Clear(); foreach (var block in ordered) baseBlocks.Add(block);
            var ids = ordered.Select(JsonData.Id).ToArray();
            if (!Ids(Nodes).SequenceEqual(ids))
            {
                var byId = Nodes.OfType<JsonObject>().ToDictionary(n => JsonData.Id(n)!); Nodes.Clear();
                foreach (var block in ordered) { var id = JsonData.Id(block)!; Nodes.Add(byId.TryGetValue(id, out var n) ? n : block["node"]!.DeepClone()); }
                contentChanged = true;
            }
        }
        if (envelope["styles"] is JsonObject styles) { Project["styles"] = styles.DeepClone(); StyleGeneration++; }
        var revision = envelope["documentRevision"]?.GetValue<long>() ?? Revision(envelope);
        if (revision > Revision(Project)) Project["revision"] = revision;
        // Own responses do not move the change cursor: unrelated changes may have committed before this save.
        if (contentChanged) ContentGeneration++;
        Changed?.Invoke(this, EventArgs.Empty);
    }

    private void RemoveBaseBlock(string id)
    {
        var old = Blocks(BaseSection).FirstOrDefault(b => JsonData.Id(b) == id); if (old != null) Blocks(BaseSection).Remove(old);
    }
    private void ReplaceBaseBlock(JsonObject block)
    {
        var id = JsonData.Id(block)!; var blocks = Blocks(BaseSection); var old = blocks.FirstOrDefault(b => JsonData.Id(b) == id);
        if (old == null) blocks.Add(block); else blocks[blocks.IndexOf(old)] = block;
        _baseBlocks[id] = block;
    }

    public async Task RefreshAsync()
    {
        if (_saving || Conflicted || Project == null) return;
        await EnsureSectionLoadedAsync();
        var info = await client.RevisionInfoAsync();
        if (_saving || Conflicted || Project == null) return;
        if (info["id"]?.GetValue<string>() != Project["id"]?.GetValue<string>())
        {
            if (Dirty) MarkConflict("其他客户端切换了项目，本地草稿已保留。");
            var manifest = await client.GetProjectAsync(); if (manifest != null) await LoadProjectAsync(manifest); return;
        }
        if (Revision(info) <= _cursor) return;
        bool more;
        do
        {
            var args = ProjectArgs(); args["since_revision"] = _cursor; args["limit"] = 100; args["section_id"] = SectionId;
            var result = (await client.ToolAsync("get_changes", args)).AsObject();
            if (_saving || Conflicted) return;
            if (result["resetRequired"]?.GetValue<bool>() == true)
            {
                if (Dirty) MarkConflict("变更历史已截断，本地草稿已保留。请明确重新读取已保存版本。");
                var manifest = await client.GetProjectAsync() ?? throw new ServiceException("项目已关闭", 404);
                await LoadProjectAsync(manifest); return;
            }
            foreach (var change in (result["changes"] as JsonArray ?? []).OfType<JsonObject>())
            {
                if (change["changeId"]?.GetValue<string>() is string ownChange && _ownChanges.Remove(ownChange)) { _cursor = Math.Max(_cursor, Revision(change)); continue; }
                // A save response already applied this block revision; stale records must never regress it.
                var filtered = change.DeepClone().AsObject();
                filtered["changedBlocks"] = new JsonArray((change["changedBlocks"] as JsonArray ?? []).OfType<JsonObject>()
                    .Where(b => !_baseBlocks.TryGetValue(JsonData.Id(b)!, out var old) || Revision(b) > Revision(old)).Select(b => b.DeepClone()).ToArray());
                ApplyEnvelope(filtered); _cursor = Math.Max(_cursor, Revision(change));
            }
            more = result["hasMore"]?.GetValue<bool>() ?? false;
            if (!more) _cursor = Math.Max(_cursor, Revision(result));
        } while (more);
        if (SectionId == null && (Project["sections"] as JsonArray)?.FirstOrDefault() is JsonObject first) await LoadSectionAsync(first["id"]!.GetValue<string>(), true);
        if (Dirty) KeepDraft();
    }

    private void MarkConflict(string message)
    {
        Conflicted = true; KeepDraft(); Changed?.Invoke(this, EventArgs.Empty); throw new ServiceException(message, 409);
    }
    public async Task ReloadConflictAsync()
    {
        var manifest = await client.GetProjectAsync() ?? throw new ServiceException("当前服务没有打开项目", 404);
        RemoveDraft(); SetProject(manifest); if (SectionId != null) await LoadSectionAsync(SectionId, false);
    }
    public string GetDraftJson() => new JsonObject
    {
        ["formatVersion"] = 2, ["projectId"] = Project?["id"]?.DeepClone(), ["projectPath"] = Project?["path"]?.DeepClone(),
        ["sectionId"] = SectionId, ["sectionRevision"] = Revision(BaseSection),
        ["changed"] = new JsonArray(_dirtyIds.Select(id => (JsonNode)new JsonObject { ["id"] = id, ["expectedRevision"] = _baseBlocks.TryGetValue(id, out var b) ? Revision(b) : 0, ["node"] = Nodes.FirstOrDefault(n => JsonData.Id(n) == id)?.DeepClone() }).ToArray()),
        ["order"] = _structural ? new JsonArray(Ids(Nodes).Select(id => JsonValue.Create(id) as JsonNode).ToArray()) : null,
        ["restoreMap"] = new JsonObject(_restoreMap.Select(p => KeyValuePair.Create<string, JsonNode?>(p.Key, JsonValue.Create(p.Value)))),
        ["savedAt"] = DateTimeOffset.UtcNow.ToString("O")
    }.ToJsonString();
    private string? DraftPath()
    {
        if (Project == null || SectionId == null) return null;
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Project["id"]?.GetValue<string>() + ":" + SectionId)));
        return Path.Combine(client.RuntimeDirectory, "drafts", key + ".json");
    }
    private void KeepDraft()
    {
        var path = DraftPath(); if (path == null) return;
        try { Directory.CreateDirectory(Path.GetDirectoryName(path)!); File.WriteAllText(path + ".tmp", GetDraftJson(), new UTF8Encoding(false)); File.Move(path + ".tmp", path, true); DraftPersistenceError = null; }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { DraftPersistenceError = e.Message; }
    }
    private void RemoveDraft()
    {
        var path = DraftPath(); if (path == null) return;
        try { File.Delete(path); DraftPersistenceError = null; } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { DraftPersistenceError = e.Message; }
    }
    private void RestoreDraft()
    {
        var path = DraftPath(); if (path == null || !File.Exists(path)) return;
        try
        {
            var draft = JsonNode.Parse(File.ReadAllText(path))?.AsObject();
            if (draft == null || draft["projectId"]?.GetValue<string>() != Project?["id"]?.GetValue<string>() || draft["sectionId"]?.GetValue<string>() != SectionId) return;
            if (draft["restoreMap"] is JsonObject restorations) foreach (var p in restorations) _restoreMap[p.Key] = p.Value!.GetValue<long>();
            if (draft["changed"] is JsonArray changes)
            {
                var nodes = new JsonArray(changes.OfType<JsonObject>().Where(c => c["node"] != null).Select(c => c["node"]!.DeepClone()).ToArray());
                var order = (draft["order"] as JsonArray)?.Select(v => v!.GetValue<string>()).ToArray() ?? Ids(Nodes);
                SetChangedNodes(nodes, order);
            }
            else if (draft["nodes"] is JsonArray legacy) SetNodes(legacy);
            if (Dirty) Conflicted = true;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException) { DraftPersistenceError = "草稿无法读取：" + e.Message; }
    }
}
