using System.Text.Json.Nodes;

namespace AgentDocument.WinUI.Controls;

/// <summary>Only changed root blocks are retained by undo; unaffected blocks keep their current revision.</summary>
public sealed class BlockEditDelta
{
    public Dictionary<string, JsonObject?> Before { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, JsonObject?> After { get; } = new(StringComparer.Ordinal);
    public string[]? BeforeOrder { get; set; }
    public string[]? AfterOrder { get; set; }
    public bool IsEmpty => Before.Count == 0 && BeforeOrder == null;
    public static BlockEditDelta Capture(IReadOnlyDictionary<string, JsonObject> baseline, IReadOnlyList<string> oldOrder, JsonArray nodes, string? root = null)
    {
        var delta = new BlockEditDelta();
        var current = nodes.OfType<JsonObject>().ToDictionary(n => DocumentNodes.Id(n)!);
        var order = nodes.OfType<JsonObject>().Select(n => DocumentNodes.Id(n)!).ToArray();
        bool structural = !oldOrder.SequenceEqual(order);
        IEnumerable<string> candidates = root != null && !structural ? new[] { root } : baseline.Keys.Union(current.Keys);
        foreach (var id in candidates)
        {
            baseline.TryGetValue(id, out var before); current.TryGetValue(id, out var after);
            if (JsonNode.DeepEquals(before, after)) continue;
            delta.Before[id] = before?.DeepClone().AsObject(); delta.After[id] = after?.DeepClone().AsObject();
        }
        if (structural) { delta.BeforeOrder = oldOrder.ToArray(); delta.AfterOrder = order; }
        return delta;
    }
    public void Apply(JsonArray nodes, bool redo)
    {
        var patches = redo ? After : Before;
        foreach (var patch in patches)
        {
            var old = nodes.FirstOrDefault(n => DocumentNodes.Id(n!.AsObject()) == patch.Key);
            if (patch.Value == null) { if (old != null) nodes.Remove(old); }
            else if (old == null) nodes.Add(patch.Value.DeepClone());
            else nodes[nodes.IndexOf(old)] = patch.Value.DeepClone();
        }
        var order = redo ? AfterOrder : BeforeOrder;
        if (order == null) return;
        var byId = nodes.OfType<JsonObject>().ToDictionary(n => DocumentNodes.Id(n)!); nodes.Clear();
        foreach (var id in order) if (byId.Remove(id, out var n)) nodes.Add(n);
        foreach (var n in byId.Values) nodes.Add(n);
    }
    public void Remap(IReadOnlyDictionary<string, string> mappings)
    {
        foreach (var patches in new[] { Before, After }) foreach (var pair in mappings)
        {
            if (!patches.Remove(pair.Key, out var node)) continue;
            if (node != null) DocumentNodes.Attributes(node)["id"] = pair.Value;
            patches[pair.Value] = node;
        }
        string[]? Map(string[]? order) => order?.Select(id => mappings.TryGetValue(id, out var next) ? next : id).ToArray();
        BeforeOrder = Map(BeforeOrder); AfterOrder = Map(AfterOrder);
    }
}
