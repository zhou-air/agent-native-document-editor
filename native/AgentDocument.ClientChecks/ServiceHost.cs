using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using AgentDocument.Client;
sealed class ServiceHost(Process process)
{
    public static async Task<ServiceHost> StartAsync(string workspace, string runtime, int port)
    {
        Directory.CreateDirectory(runtime);
        var backend = workspace;
        var serviceUri = new Uri(Path.Combine(backend, "src", "service.js")).AbsoluteUri;
        var info = new ProcessStartInfo
        {
            FileName = File.Exists(Path.Combine(backend, "node.exe")) ? Path.Combine(backend, "node.exe") : "node",
            WorkingDirectory = backend,
            CreateNoWindow = true,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        info.Environment["AGENTDOC_RUNTIME"] = runtime;
        info.Environment["AGENTDOC_PORT"] = port.ToString();
        info.ArgumentList.Add("--input-type=module");
        info.ArgumentList.Add("-e");
        info.ArgumentList.Add("await import(" + JsonSerializer.Serialize(serviceUri) + "); process.stdin.on('data', () => process.emit('SIGTERM')); process.stdin.resume();");
        var process = Process.Start(info)!;
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        using var probe = new ServiceClient(workspace, runtime, port);
        // Wait for the already-launched harness service instead of triggering a second service.
        for (var i = 0; i < 100; i++)
        {
            if (process.HasExited) throw new IOException("Isolated service exited with " + process.ExitCode);
            if (File.Exists(Path.Combine(runtime, "connection.json")))
            {
                var data = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(runtime, "connection.json")));
                if (data?["pid"]?.GetValue<int>() == process.Id)
                {
                    await probe.ConnectAsync();
                    return new ServiceHost(process);
                }
            }
            await Task.Delay(100);
        }
        process.Kill();
        throw new TimeoutException("Isolated service did not become ready");
    }

    public async Task StopAsync()
    {
        if (process.HasExited) return;
        await process.StandardInput.WriteLineAsync("stop");
        await process.StandardInput.FlushAsync();
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
    }
}
