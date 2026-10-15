using System.Runtime.InteropServices;
using Microsoft.UI.Xaml;

namespace AgentDocument.WinUI;

public partial class App : Application
{
    private Window? _window;
    public App()
    {
        InitializeComponent();
        UnhandledException += (_, e) =>
        {
            try { File.AppendAllText(Path.Combine(AppContext.BaseDirectory, "startup-errors.log"), $"{DateTime.Now:u} {e.Exception}\n"); } catch { }
        };
    }
    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        try { _window = new MainWindow(); _window.Activate(); }
        catch (Exception ex)
        {
            try { File.AppendAllText(Path.Combine(AppContext.BaseDirectory, "startup-errors.log"), $"{DateTime.Now:u} {ex}\n"); } catch { }
            MessageBoxW(0, ex.ToString(), "文档工作台启动失败", 0x10); Exit();
        }
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(nint hwnd, string text, string caption, uint type);
}
