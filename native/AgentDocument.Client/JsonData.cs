using System.Text.Json.Nodes;

namespace AgentDocument.Client;

/// <summary>Helpers for the service's lossless node and project representation.</summary>
public static class JsonData
{
    public static string? Id(JsonNode? node) => node?["attrs"]?["id"]?.GetValue<string>()
        ?? node?["id"]?.GetValue<string>();

    public static string Text(JsonNode? node)
    {
        if (node is not JsonObject obj) return string.Empty;
        if (obj["type"]?.GetValue<string>() == "text") return obj["text"]?.GetValue<string>() ?? string.Empty;
        if (obj["type"]?.GetValue<string>() == "hardBreak") return "\n";
        return string.Join(obj["type"]?.GetValue<string>() == "tableRow" ? "\t" : "",
            (obj["content"] as JsonArray ?? []).Select(Text));
    }

    public static JsonArray NodesOf(JsonObject section) => new(
        (section["blocks"] as JsonArray ?? []).Select(b => b?["node"]?.DeepClone()).ToArray());

    public static JsonObject? FindSection(JsonObject? project, string? id) =>
        (project?["sections"] as JsonArray)?.OfType<JsonObject>()
            .FirstOrDefault(section => section["id"]?.GetValue<string>() == id);

    public static JsonObject NewParagraph(string text = "")
    {
        var node = new JsonObject { ["type"] = "paragraph", ["attrs"] = new JsonObject { ["id"] = Guid.NewGuid().ToString() } };
        node["content"] = string.IsNullOrEmpty(text) ? new JsonArray() :
            new JsonArray(new JsonObject { ["type"] = "text", ["text"] = text });
        return node;
    }

    public static JsonNode CloneWithNewIds(JsonNode node)
    {
        var copy = node.DeepClone();
        AssignIds(copy, new HashSet<string>(StringComparer.Ordinal), true);
        return copy;
    }

    /// <summary>Repairs only absent or duplicate identities. Existing IDs and unknown fields survive.</summary>
    public static JsonNode EnsureIds(JsonNode node)
    {
        AssignIds(node, new HashSet<string>(StringComparer.Ordinal), false);
        return node;
    }

    private static void AssignIds(JsonNode? node, HashSet<string> seen, bool fresh)
    {
        if (node is JsonArray array)
        {
            foreach (var child in array) AssignIds(child, seen, fresh);
            return;
        }
        if (node is not JsonObject obj) return;
        var type = obj["type"]?.GetValue<string>();
        if (type is not null and not "text" and not "doc")
        {
            var attrs = obj["attrs"] as JsonObject;
            if (attrs is null) obj["attrs"] = attrs = new JsonObject();
            var id = attrs["id"]?.GetValue<string>();
            if (fresh || string.IsNullOrWhiteSpace(id) || !seen.Add(id))
            {
                id = Guid.NewGuid().ToString();
                attrs["id"] = id;
                seen.Add(id);
            }
        }
        if (obj["content"] is JsonArray content)
            foreach (var child in content) AssignIds(child, seen, fresh);
    }
}
