using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;

namespace AgentDocument.Client;

public sealed class ServiceException(string message, int statusCode) : Exception(message)
{
    public int StatusCode { get; } = statusCode;
}

/// <summary>Native HTTP client. The existing local service remains the only project writer.</summary>
public class ServiceClient : IDisposable
{
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(120) };
    private readonly SemaphoreSlim _connectGate = new(1, 1);
    private readonly string _workspace;
    private string? _token;
    private Uri? _baseUri;
    private Process? _startedProcess;
    private readonly object _logGate = new();

    public ServiceClient(string workspace, string? runtimeDirectory = null, int? port = null)
    {
        _workspace = Path.GetFullPath(workspace);
        RuntimeDirectory = Path.GetFullPath(runtimeDirectory ?? Path.Combine(_workspace, ".runtime-local"));
        Port = port ?? 47831;
        if (Port is < 1 or > 65535) throw new ArgumentOutOfRangeException(nameof(port));
    }

    public string RuntimeDirectory { get; }
    public int Port { get; }
    public int? StartedProcessId => _startedProcess is { HasExited: false } ? _startedProcess.Id : null;

    public async Task ConnectAsync()
    {
        await _connectGate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (await TryConnectionAsync().ConfigureAwait(false)) return;
            Directory.CreateDirectory(RuntimeDirectory);
            StartService();
            for (var i = 0; i < 150; i++)
            {
                if (await TryConnectionAsync().ConfigureAwait(false)) return;
                await Task.Delay(100).ConfigureAwait(false);
            }
            throw new IOException("无法启动本地文档服务，请查看 " + Path.Combine(RuntimeDirectory, "service.log"));
        }
        finally { _connectGate.Release(); }
    }

    private async Task<bool> TryConnectionAsync()
    {
        try
        {
            var json = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(RuntimeDirectory, "connection.json")).ConfigureAwait(false));
            var url = json?["url"]?.GetValue<string>();
            var token = json?["token"]?.GetValue<string>();
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != "http" ||
                uri.Host != "127.0.0.1" || uri.Port != Port || string.IsNullOrWhiteSpace(token)) return false;
            using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(uri, "/api/health"));
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            using var timeout = new CancellationTokenSource(TimeSpan.FromMilliseconds(800));
            using var response = await _http.SendAsync(request, timeout.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) return false;
            var health = JsonNode.Parse(await response.Content.ReadAsStringAsync().ConfigureAwait(false));
            if (health?["apiVersion"]?.GetValue<int>() != 2) throw new ServiceException("当前仍有旧版文档服务运行。请先保存并关闭旧版 Agent Document 后重新启动。", 426);
            _token = token;
            _baseUri = uri;
            return true;
        }
        catch (Exception e) when (e is IOException or HttpRequestException or TaskCanceledException or System.Text.Json.JsonException or InvalidOperationException)
        { return false; }
    }

    private void StartService()
    {
        if (_startedProcess is { HasExited: false }) return;
        var applicationBackend = Path.Combine(AppContext.BaseDirectory, "backend");
        var packagedBackend = Path.Combine(_workspace, "release", "AgentDocument-WinUI-x64", "backend");
        var adjacentBackend = Path.Combine(_workspace, "backend");
        var backend = File.Exists(Path.Combine(applicationBackend, "node.exe")) && File.Exists(Path.Combine(applicationBackend, "src", "service.js")) ? applicationBackend :
            File.Exists(Path.Combine(_workspace, "src", "service.js")) ? _workspace : File.Exists(Path.Combine(packagedBackend, "node.exe")) && File.Exists(Path.Combine(packagedBackend, "src", "service.js"))
            ? packagedBackend : File.Exists(Path.Combine(adjacentBackend, "node.exe")) && File.Exists(Path.Combine(adjacentBackend, "src", "service.js"))
                ? adjacentBackend : _workspace;
        var service = Path.Combine(backend, "src", "service.js");
        if (!File.Exists(service)) throw new FileNotFoundException("缺少本地文档服务", service);
        var info = new ProcessStartInfo
        {
            FileName = File.Exists(Path.Combine(backend, "node.exe")) ? Path.Combine(backend, "node.exe") : "node",
            WorkingDirectory = backend,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        info.ArgumentList.Add(service);
        info.Environment["AGENTDOC_RUNTIME"] = RuntimeDirectory;
        info.Environment["AGENTDOC_PORT"] = Port.ToString(System.Globalization.CultureInfo.InvariantCulture);
        try
        {
            _startedProcess = Process.Start(info) ?? throw new IOException("本地文档服务未启动");
            _startedProcess.OutputDataReceived += (_, e) => AppendLog(e.Data);
            _startedProcess.ErrorDataReceived += (_, e) => AppendLog(e.Data);
            _startedProcess.BeginOutputReadLine();
            _startedProcess.BeginErrorReadLine();
        }
        catch (System.ComponentModel.Win32Exception e)
        {
            throw new IOException("没有找到 Node.js，请使用包含运行环境的发布版本。", e);
        }
    }

    private void AppendLog(string? line)
    {
        if (line is null) return;
        try
        {
            lock (_logGate) File.AppendAllText(Path.Combine(RuntimeDirectory, "service.log"), line + Environment.NewLine);
        }
        catch (IOException) { }
    }

    private async Task<HttpResponseMessage> RequestAsync(string route, JsonObject? body = null)
    {
        if (_baseUri is null || _token is null) await ConnectAsync().ConfigureAwait(false);
        for (var attempt = 0; ; attempt++)
        {
            using var request = new HttpRequestMessage(body is null ? HttpMethod.Get : HttpMethod.Post, new Uri(_baseUri!, route));
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
            if (body is not null) request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
            var response = await _http.SendAsync(request).ConfigureAwait(false);
            if (response.StatusCode == HttpStatusCode.Unauthorized && attempt == 0)
            {
                response.Dispose();
                await ConnectAsync().ConfigureAwait(false);
                continue;
            }
            if (response.IsSuccessStatusCode) return response;
            string message;
            try
            {
                var data = JsonNode.Parse(await response.Content.ReadAsStringAsync().ConfigureAwait(false));
                message = data?["error"]?.GetValue<string>() ?? "本地文档服务请求失败";
            }
            catch (System.Text.Json.JsonException) { message = "本地文档服务请求失败"; }
            var status = (int)response.StatusCode;
            response.Dispose();
            throw new ServiceException(message, status);
        }
    }

    private async Task<JsonNode> JsonAsync(string route, JsonObject? body = null)
    {
        using var response = await RequestAsync(route, body).ConfigureAwait(false);
        return JsonNode.Parse(await response.Content.ReadAsStringAsync().ConfigureAwait(false))
            ?? throw new IOException("本地文档服务返回空数据");
    }

    public async Task<JsonObject?> GetProjectAsync() => (await JsonAsync("/api/project").ConfigureAwait(false))["project"] as JsonObject;
    public async Task<JsonArray> ListProjectsAsync(string root) => (await JsonAsync("/api/projects?root=" + Uri.EscapeDataString(Path.GetFullPath(root))).ConfigureAwait(false))["projects"]!.AsArray();
    public async Task<long> GetRevisionAsync() => (await RevisionInfoAsync().ConfigureAwait(false))["revision"]?.GetValue<long>() ?? 0;
    public async Task<JsonObject> RevisionInfoAsync() => (await JsonAsync("/api/revision").ConfigureAwait(false)).AsObject();
    public virtual Task<JsonNode> ToolAsync(string name, JsonObject args) => JsonAsync("/api/tool", new JsonObject { ["name"] = name, ["args"] = args.DeepClone() });
    public async Task<JsonObject> OpenProjectAsync(string path) => (await JsonAsync("/api/open", new JsonObject { ["path"] = path }).ConfigureAwait(false)).AsObject();
    public async Task<JsonObject> CreateProjectAsync(string path, string title, byte[]? docx = null, string? filename = null, bool freshDocument = false)
    {
        var args = new JsonObject { ["path"] = path, ["title"] = title };
        if (freshDocument) args["fresh_document"] = true;
        if (docx is not null) { args["docx"] = Convert.ToBase64String(docx); args["filename"] = filename; }
        return (await JsonAsync("/api/create", args).ConfigureAwait(false)).AsObject();
    }
    public async Task<JsonObject> AddAssetAsync(byte[] bytes, string filename, string? expectedProjectId = null)
    {
        var args = new JsonObject { ["name"] = filename, ["data"] = Convert.ToBase64String(bytes) };
        if (expectedProjectId is not null) args["project_id"] = expectedProjectId;
        return (await JsonAsync("/api/asset", args).ConfigureAwait(false)).AsObject();
    }
    public async Task<byte[]> ExportAsync(string[]? sectionIds = null, string? expectedProjectId = null, string format = "docx")
    {
        var args = new JsonObject();
        if (expectedProjectId is not null) args["project_id"] = expectedProjectId;
        if (sectionIds is not null) args["section_ids"] = new JsonArray(sectionIds.Select(id => JsonValue.Create(id) as JsonNode).ToArray());
        args["format"] = format;
        using var response = await RequestAsync("/api/export", args).ConfigureAwait(false);
        return await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
    }
    public async Task<byte[]> GetAssetAsync(string relativePath)
    {
        ValidateAssetPath(relativePath);
        using var response = await RequestAsync("/" + relativePath).ConfigureAwait(false);
        return await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
    }
    public Uri GetAssetUri(string relativePath)
    {
        ValidateAssetPath(relativePath);
        if (_baseUri is null || _token is null) throw new InvalidOperationException("请先连接本地文档服务");
        return new Uri(_baseUri, "/" + relativePath + "?token=" + Uri.EscapeDataString(_token));
    }
    private static void ValidateAssetPath(string path)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(path, @"\Aassets/[\w.-]+\z", System.Text.RegularExpressions.RegexOptions.CultureInvariant))
            throw new ArgumentException("图片必须使用项目 assets/ 相对路径", nameof(path));
    }

    /// <summary>Closing a frontend does not stop the shared MCP/data service.</summary>
    public void Dispose() { _http.Dispose(); _connectGate.Dispose(); _startedProcess?.Dispose(); }
}
