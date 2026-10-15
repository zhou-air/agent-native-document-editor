namespace AgentDocument.Client;

public static class ProjectPaths
{
    public static string NewDirectory(string root, string title)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var name = new string(title.Select(c => invalid.Contains(c) ? '_' : c).Take(60).ToArray()).Trim(' ', '.');
        if (name.Length == 0) name = "文档";
        // An underscore prefix also handles Windows device names such as CON.docx.
        return Path.Combine(Path.GetFullPath(root), "_" + name + "-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N")[..8]);
    }
}
