param([string]$ExecutablePath,[string]$BackendRoot,[string]$RunDirectory,[int]$Port,[switch]$ImagePicker,[switch]$ExportPicker)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class PickerForegroundProbe {[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();}'
$info=New-Object Diagnostics.ProcessStartInfo
$info.FileName=$ExecutablePath
$info.UseShellExecute=$false
$info.Arguments='--workspace "'+$BackendRoot+'" --runtime "'+$RunDirectory+'\runtime" --port '+$Port+' --project "'+$RunDirectory+'\project" --diagnostics "'+$RunDirectory+'\native-diagnostics.json"'
$app=[Diagnostics.Process]::Start($info)
try {
 Start-Sleep -Seconds 3
 $app.Refresh()
 $root=[Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle)
 if($ImagePicker -or $ExportPicker){
 if($ImagePicker){
  $tab=$root.FindFirst([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::AutomationIdProperty,'InsertTab')))
  $tab.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern).Toggle()
  Start-Sleep -Milliseconds 300
  $button=$root.FindFirst([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::AutomationIdProperty,'Ribbon_InsertImage')))
  $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
 }else{
  $button=$root.FindFirst([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::AutomationIdProperty,'ExportButton')))
  $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
  Start-Sleep -Seconds 1
  $primary=$root.FindFirst([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,'选择保存位置')))
  $primary.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
 }
  Start-Sleep -Seconds 2
  $root=[Windows.Automation.AutomationElement]::FromHandle([PickerForegroundProbe]::GetForegroundWindow())
 }
 $all=$root.FindAll([Windows.Automation.TreeScope]::Subtree,[Windows.Automation.Condition]::TrueCondition)
 $lines=New-Object 'Collections.Generic.List[object]'
 foreach($element in $all){$current=$element.Current; $lines.Add([pscustomobject]@{id=$current.AutomationId;name=$current.Name;class=$current.ClassName;framework=$current.FrameworkId;type=$current.ControlType.ProgrammaticName;process=$current.ProcessId;hwnd=$current.NativeWindowHandle})}
 $lines | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $RunDirectory 'uia-tree.json') -Encoding UTF8
 if($ImagePicker -or $ExportPicker){$lines | Where-Object {$_.type -eq 'ControlType.Edit' -or $_.type -eq 'ControlType.Window' -or $_.class -eq 'Edit'} | Select-Object -First 60 | Format-Table -AutoSize}
 else{$lines | Select-Object -First 35 | Format-Table -AutoSize}
} finally {if(-not $app.HasExited){[void]$app.CloseMainWindow(); if(-not $app.WaitForExit(2000)){$app.Kill()}}}
