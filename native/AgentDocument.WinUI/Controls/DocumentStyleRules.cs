using System.Text.Json.Nodes;

namespace AgentDocument.WinUI.Controls;

public sealed record ResolvedDocumentStyle(string EastAsia, string Latin, double Size, bool Bold, bool Italic, string Alignment, double Before, double After, double Line, string LineRule, double FirstLine, double Left, double Right);

public static class DocumentStyleRules
{
    private static double Number(JsonNode? value, double fallback) => double.TryParse(value?.ToString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var n) && double.IsFinite(n) ? n : fallback;
    public static ResolvedDocumentStyle Resolve(JsonObject? styles, JsonObject node, bool table = false)
    {
        var heading = DocumentNodes.Type(node) == "heading";
        var level = Math.Clamp((int)Number(node["attrs"]?["level"], 1), 1, 9);
        var rule = heading ? styles?["semantic"]?["headings"]?[level.ToString()] : styles?["semantic"]?[table ? "table" : "body"];
        var f = rule?["font"]; var p = rule?["paragraph"]; var indent = p?["indent"];
        var defaultSize = heading ? level == 1 ? 20 : level == 2 ? 16 : 14 : table ? 10.5 : 12;
        var before = rule is null && heading ? 12 : 0; var after = rule is null && !table ? 6 : 0;
        var code = DocumentNodes.Type(node) == "codeBlock";
        return new ResolvedDocumentStyle(
            code ? "Consolas" : f?["eastAsia"]?.ToString() ?? (rule is null && heading ? "黑体" : "宋体"),
            code ? "Consolas" : f?["latin"]?.ToString() ?? f?["ascii"]?.ToString() ?? "Calibri",
            Math.Clamp(Number(f?["sizePt"], rule is null ? defaultSize : 12), 1, 144),
            f?["bold"]?.GetValue<bool>() ?? (rule is null && heading), f?["italic"]?.GetValue<bool>() == true,
            p?["alignment"]?.ToString() ?? "left", Number(p?["beforePt"], before), Number(p?["afterPt"], after),
            Number(p?["line"], rule is null && !heading && !table ? 360 : 240), p?["lineRule"]?.ToString() is "exact" ? "exact" : p?["lineRule"]?.ToString() is "atLeast" ? "atLeast" : "auto",
            (Number(indent?["firstLine"], 0) - Number(indent?["hanging"], 0)) / 20, Number(indent?["left"], 0) / 20, Number(indent?["right"], 0) / 20);
    }
    // A style's presentation must never become a new inline mark just because text was edited.
    public static bool InlineEmphasis(bool displayed, bool inherited, bool existing) => inherited && displayed ? existing : displayed;
    public static bool IsEastAsian(char c) => c >= '\u2E80' && c <= '\uA4CF' || c >= '\uAC00' && c <= '\uD7AF' || c >= '\uF900' && c <= '\uFAFF' || c >= '\uFE30' && c <= '\uFFEF';
}
