using System.Net;
using System.Text.Json.Nodes;

namespace AgentDocument.WinUI.Controls;

/// <summary>Standard clipboard representations accompany the lossless private JSON payload.</summary>
public static class DocumentClipboard
{
    public const string NodesFormat = "application/x-agent-native-document-nodes+json";
    private static string E(string value) => WebUtility.HtmlEncode(value);
    public static string Plain(JsonObject node)
    {
        return DocumentNodes.Type(node) switch
        {
            "text" => DocumentNodes.Text(node), "hardBreak" => "\n",
            "image" => "[图片：" + ((node["attrs"] as JsonObject)?["alt"]?.GetValue<string>() ?? "") + "]",
            "tableRow" => string.Join("\t", DocumentNodes.Children(node).Select(Plain)),
            "doc" or "table" or "bulletList" or "orderedList" => string.Join("\n", DocumentNodes.Children(node).Select(Plain)),
            "tableCell" or "tableHeader" or "listItem" or "blockquote" => string.Join("\n", DocumentNodes.Children(node).Select(Plain)),
            _ => string.Concat(DocumentNodes.Children(node).Select(Plain))
        };
    }
    public static string Html(JsonObject node, string? projectPath = null)
    {
        var attrs = node["attrs"] as JsonObject;
        string type = DocumentNodes.Type(node);
        string body = string.Concat(DocumentNodes.Children(node).Select(n => Html(n, projectPath)));
        if (type == "text")
        {
            body = E(DocumentNodes.Text(node));
            foreach (var mark in (node["marks"] as JsonArray ?? []).OfType<JsonObject>())
            {
                string? tag = DocumentNodes.Type(mark) switch { "bold" => "strong", "italic" => "em", "underline" => "u", "strike" => "s", "code" => "code", "subscript" => "sub", "superscript" => "sup", _ => null };
                if (tag != null) body = $"<{tag}>{body}</{tag}>";
                else if (DocumentNodes.Type(mark) == "link" && mark["attrs"]?["href"]?.GetValue<string>() is string href && Uri.TryCreate(href, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https") body = $"<a href=\"{E(href)}\">{body}</a>";
            }
            return body;
        }
        if (type == "hardBreak") return "<br>";
        if (type == "horizontalRule") return "<hr>";
        if (type == "image")
        {
            var src = attrs?["src"]?.GetValue<string>() ?? "";
            if (projectPath != null && src.StartsWith("assets/", StringComparison.Ordinal) && !src.Contains("..")) src = new Uri(Path.GetFullPath(Path.Combine(projectPath, src))).AbsoluteUri;
            string width = attrs?["width"] is JsonValue w && w.TryGetValue<double>(out double size) && size > 0 ? $" width=\"{size}\"" : "";
            return $"<img src=\"{E(src)}\" alt=\"{E(attrs?["alt"]?.GetValue<string>() ?? "")}\"{width}>";
        }
        string? element = type switch
        {
            "doc" => "div", "paragraph" => "p", "heading" => "h" + Math.Clamp(attrs?["level"]?.GetValue<int>() ?? 2, 1, 6),
            "bulletList" => "ul", "orderedList" => "ol", "listItem" => "li", "blockquote" => "blockquote", "codeBlock" => "pre",
            "table" => "table", "tableRow" => "tr", "tableCell" => "td", "tableHeader" => "th", _ => null
        };
        if (element == null) return body;
        var properties = "";
        if (type is "tableCell" or "tableHeader") properties += $" colspan=\"{Math.Max(1, attrs?["colspan"]?.GetValue<int>() ?? 1)}\" rowspan=\"{Math.Max(1, attrs?["rowspan"]?.GetValue<int>() ?? 1)}\"";
        if (type == "orderedList") properties += $" start=\"{attrs?["start"]?.GetValue<int>() ?? 1}\"";
        var styles = new List<string>();
        if (type is "paragraph" or "heading" or "codeBlock")
        {
            if (attrs?["fontFamily"]?.GetValue<string>() is string font) styles.Add("font-family:" + font.Replace(";", "").Replace("\"", ""));
            if (attrs?["fontSize"] is JsonValue pt && double.TryParse(pt.ToJsonString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out double fontSize)) styles.Add("font-size:" + fontSize.ToString(System.Globalization.CultureInfo.InvariantCulture) + "pt");
            if (attrs?["textAlign"]?.GetValue<string>() is string align && align is "left" or "center" or "right" or "justify") styles.Add("text-align:" + align);
        }
        if (styles.Count > 0) properties += " style=\"" + E(string.Join(';', styles)) + "\"";
        return $"<{element}{properties}>{body}</{element}>";
    }
    public static JsonArray FromText(string text) => new(text.Replace("\r\n", "\n").Replace('\r', '\n').Replace('\u2028', '\n').Replace('\u2029', '\n')
        .Split('\n').Where(line => !string.IsNullOrWhiteSpace(line)).Select(line => (JsonNode)DocumentNodes.Paragraph(line)).ToArray());

    public static bool IsEmptyTextBlock(JsonObject? node) => node != null
        && DocumentNodes.Type(node) is "paragraph" or "heading"
        && DocumentNodes.Descendants(node).Skip(1).All(child => DocumentNodes.Type(child) is "text" or "hardBreak")
        && string.IsNullOrWhiteSpace(DocumentNodes.Text(node));

    /// <summary>Reuse the empty target's identity and formatting for the first paragraph of pasted text.</summary>
    public static string? FillEmptyTextBlock(JsonArray nodes, JsonObject target, IReadOnlyList<JsonObject> paragraphs)
    {
        if (paragraphs.Count == 0) return null;
        if (!IsEmptyTextBlock(target) || !nodes.Contains(target)) throw new InvalidOperationException("只能在空白文字块中拆分粘贴的段落。");
        target["content"] = DocumentNodes.Content(paragraphs[0]).DeepClone();
        return InsertAfterSelected(nodes, paragraphs.Skip(1).ToArray(), DocumentNodes.Id(target)) ?? DocumentNodes.Id(target);
    }

    /// <summary>Insert complete prepared blocks after the selected root, or append when no root is selected.</summary>
    public static string? InsertAfterSelected(JsonArray nodes, IReadOnlyList<JsonObject> incoming, string? selectedId)
    {
        if (incoming.Count == 0) return null;
        int index = nodes.Count;
        if (selectedId != null)
            for (int i = 0; i < nodes.Count; i++)
                if (nodes[i] is JsonObject node && DocumentNodes.Id(node) == selectedId) { index = i + 1; break; }
        string? lastId = null;
        foreach (var node in incoming)
        {
            var inserted = node.Parent == null ? node : node.DeepClone().AsObject();
            nodes.Insert(index++, inserted); lastId = DocumentNodes.Id(inserted);
        }
        return lastId;
    }
}
