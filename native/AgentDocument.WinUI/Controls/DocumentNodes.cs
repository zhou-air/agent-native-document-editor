using System.Text.Json.Nodes;

namespace AgentDocument.WinUI.Controls;

/// <summary>Lossless operations on the shared ProseMirror JSON. Views never become the data authority.</summary>
public static class DocumentNodes
{
    public static string Type(JsonObject n) => n["type"]?.GetValue<string>() ?? "";
    public static string? Id(JsonObject n) => (n["attrs"] as JsonObject)?["id"]?.GetValue<string>();
    public static JsonObject Attributes(JsonObject n)
    {
        if (n["attrs"] is not JsonObject a) n["attrs"] = a = new JsonObject();
        return a;
    }
    public static JsonArray Content(JsonObject n)
    {
        if (n["content"] is not JsonArray a) n["content"] = a = new JsonArray();
        return a;
    }
    public static IEnumerable<JsonObject> Children(JsonObject n) => (n["content"] as JsonArray)?.OfType<JsonObject>() ?? [];
    public static string Text(JsonObject n) => Type(n) == "text" ? n["text"]?.GetValue<string>() ?? "" : Type(n) == "hardBreak" ? "\v" : string.Concat(Children(n).Select(Text));
    public static JsonObject Paragraph(string? text = null) => new()
    {
        ["type"] = "paragraph", ["attrs"] = new JsonObject { ["id"] = Guid.NewGuid().ToString() },
        ["content"] = string.IsNullOrEmpty(text) ? new JsonArray() : new JsonArray(new JsonObject { ["type"] = "text", ["text"] = text })
    };
    public static JsonObject FreshCopy(JsonObject n)
    {
        var copy = (JsonObject)n.DeepClone();
        AssignIds(copy, true);
        return copy;
    }
    public static void AssignIds(JsonObject n, bool fresh = false, HashSet<string>? seen = null)
    {
        seen ??= [];
        if (Type(n) is not ("text" or "doc"))
        {
            var id = Id(n);
            if (fresh || string.IsNullOrEmpty(id) || !seen.Add(id))
            {
                id = Guid.NewGuid().ToString(); Attributes(n)["id"] = id; seen.Add(id);
            }
        }
        foreach (var child in Children(n)) AssignIds(child, fresh, seen);
    }
    public static IEnumerable<JsonObject> Descendants(JsonObject n)
    {
        yield return n;
        foreach (var child in Children(n)) foreach (var sub in Descendants(child)) yield return sub;
    }
    public static (JsonArray parent, int index)? Locate(JsonArray roots, JsonObject target)
    {
        for (var i = 0; i < roots.Count; i++)
        {
            if (ReferenceEquals(roots[i], target)) return (roots, i);
            if (roots[i] is JsonObject child && child["content"] is JsonArray children && Locate(children, target) is { } found) return found;
        }
        return null;
    }
    public static JsonObject? Ancestor(JsonArray roots, JsonObject target, string type)
    {
        foreach (var root in roots.OfType<JsonObject>())
        {
            if (Type(root) == type && Descendants(root).Any(n => ReferenceEquals(n, target))) return root;
            if (root["content"] is JsonArray children && Ancestor(children, target, type) is { } found) return found;
        }
        return null;
    }
    public static bool HasMark(JsonObject n, string type) => (n["marks"] as JsonArray)?.OfType<JsonObject>().Any(m => Type(m) == type) == true;
    public static JsonObject? Mark(JsonObject n, string type) => (n["marks"] as JsonArray)?.OfType<JsonObject>().FirstOrDefault(m => Type(m) == type);
    public static void SetMark(JsonObject n, string type, bool enabled, JsonObject? attributes = null)
    {
        var marks = n["marks"] as JsonArray;
        var old = marks?.OfType<JsonObject>().FirstOrDefault(m => Type(m) == type);
        if (!enabled)
        {
            if (old != null) marks!.Remove(old);
            if (marks?.Count == 0) n.Remove("marks");
            return;
        }
        if (old != null)
        {
            if (attributes != null)
            {
                var a = Attributes(old);
                foreach (var entry in attributes) a[entry.Key] = entry.Value?.DeepClone();
            }
            return;
        }
        if (marks == null) n["marks"] = marks = new JsonArray();
        var mark = new JsonObject { ["type"] = type };
        if (attributes != null) mark["attrs"] = attributes.DeepClone();
        marks.Add(mark);
    }
    /// <summary>UTF-16 units carry their source node properties, including marks unknown to this editor.</summary>
    public static List<JsonObject> Explode(IEnumerable<JsonObject> content)
    {
        List<JsonObject> result = [];
        foreach (var node in content)
        {
            if (Type(node) == "text")
            {
                foreach (var ch in Text(node))
                {
                    var atom = (JsonObject)node.DeepClone(); atom["text"] = ch.ToString(); result.Add(atom);
                }
            }
            else result.Add((JsonObject)node.DeepClone());
        }
        return result;
    }
    public static string AtomText(IEnumerable<JsonObject> atoms) => string.Concat(atoms.Select(a => Type(a) == "text" ? Text(a) : Type(a) == "hardBreak" ? "\v" : "\uFFFC"));
    public static List<JsonObject> Reconcile(IEnumerable<JsonObject> source, string edited, bool literalBreaks = false)
    {
        var atoms = Explode(source); var old = AtomText(atoms);
        edited = edited.Replace("\r\n", "\n").Replace('\r', '\n');
        if (!literalBreaks) edited = edited.Replace('\n', '\v');
        int first = 0;
        while (first < old.Length && first < edited.Length && old[first] == edited[first]) first++;
        int suffix = 0;
        while (suffix < old.Length - first && suffix < edited.Length - first && old[^(suffix + 1)] == edited[^(suffix + 1)]) suffix++;
        var inherited = first > 0 && Type(atoms[first - 1]) == "text" ? atoms[first - 1]
            : first < atoms.Count && Type(atoms[first]) == "text" ? atoms[first] : new JsonObject { ["type"] = "text" };
        List<JsonObject> result = atoms.Take(first).Select(a => (JsonObject)a.DeepClone()).ToList();
        for (int i = first; i < edited.Length - suffix; i++)
        {
            if (!literalBreaks && (edited[i] is '\v' or '\n')) result.Add(new JsonObject { ["type"] = "hardBreak", ["attrs"] = new JsonObject { ["id"] = Guid.NewGuid().ToString() } });
            else
            {
                var a = (JsonObject)inherited.DeepClone(); a["text"] = edited[i].ToString(); result.Add(a);
            }
        }
        result.AddRange(atoms.Skip(atoms.Count - suffix).Select(a => (JsonObject)a.DeepClone()));
        return result;
    }
    public static JsonArray Coalesce(IEnumerable<JsonObject> atoms)
    {
        var result = new JsonArray(); JsonObject? previous = null; string? previousKey = null;
        foreach (var atom in atoms)
        {
            if (Type(atom) == "text")
            {
                if (string.IsNullOrEmpty(Text(atom))) continue;
                var properties = (JsonObject)atom.DeepClone(); properties.Remove("text"); var key = properties.ToJsonString();
                if (previous != null && key == previousKey) previous["text"] = Text(previous) + Text(atom);
                else { previous = (JsonObject)atom.DeepClone(); result.Add(previous); previousKey = key; }
            }
            else { result.Add(atom.DeepClone()); previous = null; previousKey = null; }
        }
        return result;
    }
    public static (JsonArray left, JsonArray right) SplitInline(JsonArray content, int position)
    {
        var atoms = Explode(content.OfType<JsonObject>()); position = Math.Clamp(position, 0, atoms.Count);
        return (Coalesce(atoms.Take(position)), Coalesce(atoms.Skip(position)));
    }
    public static JsonObject SplitParagraph(JsonObject paragraph, int position)
    {
        var (left, right) = SplitInline(Content(paragraph), position);
        var next = (JsonObject)paragraph.DeepClone();
        Attributes(next)["id"] = Guid.NewGuid().ToString();
        if (Type(next) == "heading") { next["type"] = "paragraph"; Attributes(next).Remove("level"); }
        paragraph["content"] = left; next["content"] = right;
        return next;
    }
    public static void JoinParagraph(JsonObject first, JsonObject second)
    {
        first["content"] = Coalesce(Explode(Children(first)).Concat(Explode(Children(second))));
    }
}
