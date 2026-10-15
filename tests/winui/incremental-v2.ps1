[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ExecutablePath,
    [Parameter(Mandatory=$true)][string]$BackendRoot,
    [Parameter(Mandatory=$true)][string]$ProjectRoot,
    [Parameter(Mandatory=$true)][string]$RuntimeDirectory,
    [Parameter(Mandatory=$true)][string]$ProjectDirectory,
    [Parameter(Mandatory=$true)][string]$DiagnosticsPath,
    [Parameter(Mandatory=$true)][string]$SeedPath,
    [Parameter(Mandatory=$true)][string]$RunDirectory,
    [Parameter(Mandatory=$true)][int]$Port,
    [switch]$ResumeAfterTables
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativeAcceptanceInput {
    [StructLayout(LayoutKind.Sequential)] public struct KeyInput { public ushort key, scan; public uint flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit, Size=32)] public struct InputUnion { [FieldOffset(0)] public KeyInput keyboard; }
    [StructLayout(LayoutKind.Sequential)] public struct Input { public uint type; public InputUnion data; }
    [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, Input[] inputs, int size);
    public static void TypeText(string text) {
        foreach (char ch in text) {
            var down=new Input {type=1,data=new InputUnion {keyboard=new KeyInput {scan=ch,flags=4}}};
            var up=down; up.data.keyboard.flags=6;
            if (SendInput(2,new[]{down,up},Marshal.SizeOf(typeof(Input)))!=2) throw new InvalidOperationException("Unicode input was rejected");
            System.Threading.Thread.Sleep(8);
        }
    }
    public delegate bool WindowCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint first, uint second, bool attach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr parameter, string text);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr window, WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, System.Text.StringBuilder text, int length);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
'@
$nodePath = if (Test-Path -LiteralPath (Join-Path $BackendRoot 'node.exe')) { Join-Path $BackendRoot 'node.exe' } else { 'node' }
$checks = New-Object 'Collections.Generic.List[object]'
$application = $null
$window = $null
$seed = Get-Content -LiteralPath $SeedPath -Raw -Encoding UTF8 | ConvertFrom-Json
$failure = $null
$originalParagraph = $null
$originalTable = $null
$restoredOriginals = $false
if ($ResumeAfterTables) {
    $checkpointPath = Join-Path $RunDirectory 'native-ui-results.json'
    $checkpoint = Get-Content -LiteralPath $checkpointPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not @($checkpoint.checks | Where-Object { $_.name -eq 'Native table merge/split preserves table identity' -and $_.status -eq 'passed' }).Count) { throw 'The requested run has no passing native table checkpoint.' }
    $checkpoint | ConvertTo-Json -Depth 70 | Set-Content -LiteralPath (Join-Path $RunDirectory 'native-ui-checkpoint.json') -Encoding UTF8
    foreach ($passedCheck in $checkpoint.checks | Where-Object { $_.status -eq 'passed' }) { $checks.Add($passedCheck) }
}

function Save-Results {
    $result = [ordered]@{ checks = $checks; error = $failure; diagnostics = $DiagnosticsPath; runtime = $RuntimeDirectory; port = $Port }
    $result | ConvertTo-Json -Depth 70 | Set-Content -LiteralPath (Join-Path $RunDirectory 'native-ui-results.json') -Encoding UTF8
}
function Passed([string]$Name, $Evidence) {
    $checks.Add([pscustomobject]@{ name = $Name; status = 'passed'; evidence = $Evidence })
    Write-Host "PASS $Name"
    Save-Results
}
function Assert-Condition([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Wait-For([scriptblock]$Condition, [string]$Description, [int]$Seconds = 20) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    $lastError = ''
    do {
        if ($application -and $application.HasExited) { throw "Native application exited while waiting for $Description (exit $($application.ExitCode))." }
        try { $value = & $Condition; if ($value) { return $value } } catch { $lastError = $_.Exception.Message }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out waiting for $Description. $lastError"
}
function Read-Diagnostics {
    if (-not (Test-Path -LiteralPath $DiagnosticsPath)) { return $null }
    return Read-UnlockedJson $DiagnosticsPath
}
function Read-UnlockedJson([string]$Path) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8, $true)
    try { return $reader.ReadToEnd() | ConvertFrom-Json }
    finally { $reader.Dispose(); $stream.Dispose() }
}
function Read-Project { return Read-UnlockedJson (Join-Path $ProjectDirectory 'project.json') }
function Find-Control([string]$Id) {
    if (-not $window) { return $null }
    $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::AutomationIdProperty, $Id)
    return $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
}
function Require-Control([string]$Id) { return Wait-For { Find-Control $Id } "native control $Id" }
function Is-OwnedWindow([IntPtr]$Handle) {
    for ($depth = 0; $depth -lt 12 -and $Handle -ne [IntPtr]::Zero; $depth++) {
        if ($Handle -eq $application.MainWindowHandle) { return $true }
        [uint32]$ownerProcess = 0
        [void][NativeAcceptanceInput]::GetWindowThreadProcessId($Handle, [ref]$ownerProcess)
        if ($ownerProcess -eq $application.Id) { return $true }
        $owner = [NativeAcceptanceInput]::GetWindow($Handle, 4)
        if ($owner -eq [IntPtr]::Zero) { $owner = [NativeAcceptanceInput]::GetParent($Handle) }
        $Handle = $owner
    }
    return $false
}
function Foreground-App {
    $application.Refresh()
    if (-not (Is-OwnedWindow ([NativeAcceptanceInput]::GetForegroundWindow()))) {
        [uint32]$foregroundProcess = 0
        $foregroundThread = [NativeAcceptanceInput]::GetWindowThreadProcessId([NativeAcceptanceInput]::GetForegroundWindow(), [ref]$foregroundProcess)
        [uint32]$targetProcess = 0
        $targetThread = [NativeAcceptanceInput]::GetWindowThreadProcessId($application.MainWindowHandle, [ref]$targetProcess)
        $currentThread = [NativeAcceptanceInput]::GetCurrentThreadId()
        if ($foregroundThread -and $foregroundThread -ne $currentThread) { [void][NativeAcceptanceInput]::AttachThreadInput($currentThread, $foregroundThread, $true) }
        if ($targetThread -and $targetThread -ne $currentThread -and $targetThread -ne $foregroundThread) { [void][NativeAcceptanceInput]::AttachThreadInput($currentThread, $targetThread, $true) }
        try {
            [void][NativeAcceptanceInput]::ShowWindow($application.MainWindowHandle, 5)
            [void][NativeAcceptanceInput]::BringWindowToTop($application.MainWindowHandle)
            [void][NativeAcceptanceInput]::SetForegroundWindow($application.MainWindowHandle)
            Start-Sleep -Milliseconds 150
        } finally {
            if ($targetThread -and $targetThread -ne $currentThread -and $targetThread -ne $foregroundThread) { [void][NativeAcceptanceInput]::AttachThreadInput($currentThread, $targetThread, $false) }
            if ($foregroundThread -and $foregroundThread -ne $currentThread) { [void][NativeAcceptanceInput]::AttachThreadInput($currentThread, $foregroundThread, $false) }
        }
    }
    if (-not (Is-OwnedWindow ([NativeAcceptanceInput]::GetForegroundWindow()))) { throw 'The test window or its owned dialog could not receive keyboard focus; keyboard input was cancelled.' }
}
function Click-Element($Control, [string]$Description) {
    $control = $Control
    Foreground-App
    $pattern = $null
    if ($control.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        $pattern.Invoke()
    } elseif ($control.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
        $pattern.Select()
    } else {
        $rectangle = $control.Current.BoundingRectangle
        Assert-Condition (-not $rectangle.IsEmpty -and -not $control.Current.IsOffscreen) "Native control is not on screen: $Description"
        @{description=$Description;bounds=$rectangle.ToString();window=$window.Current.BoundingRectangle.ToString();paper=(Find-Control 'PaperScroll').Current.BoundingRectangle.ToString()} | ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $RunDirectory 'clicks.jsonl')
        try { $point = $control.GetClickablePoint() } catch {
            $visible=$rectangle
            $visible.Intersect($window.Current.BoundingRectangle)
            if ($Description.StartsWith('Cell_')) { $visible.Intersect((Require-Control 'PaperScroll').Current.BoundingRectangle) }
            Assert-Condition (-not $visible.IsEmpty) 'The target must intersect the visible native window'
            $point=[Windows.Point]::new($visible.X+$visible.Width/2,$visible.Y+$visible.Height/2)
        }
        @{description=$Description;bounds=$rectangle.ToString();point=$point.ToString();window=$window.Current.BoundingRectangle.ToString()} | ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $RunDirectory 'clicks.jsonl')
        [void][NativeAcceptanceInput]::SetCursorPos([int]$point.X, [int]$point.Y)
        [NativeAcceptanceInput]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
        [NativeAcceptanceInput]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
    }
    Start-Sleep -Milliseconds 200
    return $control
}
function Click-Control([string]$Id) { return Click-Element (Require-Control $Id) $Id }
function Shift-Click-Control([string]$Id) {
    Foreground-App
    [NativeAcceptanceInput]::keybd_event(16, 0, 0, [UIntPtr]::Zero)
    try { [void](Click-Control $Id) }
    finally { [NativeAcceptanceInput]::keybd_event(16, 0, 2, [UIntPtr]::Zero) }
}
function Click-Name([string]$Name) {
    $control = Wait-For {
        $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, $Name)
        $found = $window.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)
        foreach ($candidate in $found) { if (-not $candidate.Current.IsOffscreen -and $candidate.Current.IsEnabled) { return $candidate } }
        return $null
    } "native control named $Name"
    return Click-Element $control $Name
}
function Keyboard([string]$Keys) { Foreground-App; if ($Keys -notmatch '[\{\}\^%+]') { [NativeAcceptanceInput]::TypeText($Keys) } else { [Windows.Forms.SendKeys]::SendWait($Keys) }; Start-Sleep -Milliseconds 200 }

function Focus-Editor([string]$Id) {
    $control = Require-Control $Id
    Foreground-App
    $control.SetFocus()
    Start-Sleep -Milliseconds 150
    return $control
}
function Focus-EditableControl([string]$Id) {
    $control = Require-Control $Id
    $editCondition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Edit)
    $edit = $control.FindFirst([Windows.Automation.TreeScope]::Descendants, $editCondition)
    if ($edit) { $control = $edit }
    Foreground-App
    $control.SetFocus()
    Start-Sleep -Milliseconds 150
    return $control
}
function Select-ComboItem([string]$Id, [string]$Name) {
    $combo = Require-Control $Id
    Foreground-App
    $expand = $null
    Assert-Condition ($combo.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$expand)) "Native ComboBox cannot be expanded: $Id"
    $expand.Expand()
    $item = Wait-For {
        $byName = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, $Name)
        foreach ($candidate in [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Descendants, $byName)) {
            if ($candidate.Current.ProcessId -eq $application.Id -and -not $candidate.Current.IsOffscreen -and $candidate.Current.ControlType -eq [Windows.Automation.ControlType]::ListItem) { return $candidate }
        }
        return $null
    } "native ComboBox item $Id / $Name"
    [void](Click-Element $item ($Id + '/' + $Name))
    Keyboard '{ESC}'
}
function Choose-Section([string]$SectionId) {
    [void](Wait-For {
        $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ClassNameProperty, 'RichEditBox')
        foreach ($candidate in $window.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)) { if ($candidate.Current.IsEnabled) { return $true } }
        return $false
    } 'native editor ready for chapter navigation')
    $label = Require-Control ('Section_' + $SectionId)
    $item = [Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($label)
    Assert-Condition ($item.Current.ControlType -eq [Windows.Automation.ControlType]::TreeItem) 'Section label must belong to a selectable native tree item'
    [void](Click-Element $item ('Section_' + $SectionId))
    [void](Wait-For { $d = Read-Diagnostics; $d -and $d.sectionId -eq $SectionId } "selected chapter $SectionId")
}
function Save-Document {
    [void](Click-Control 'SaveButton')
    [void](Wait-For { $d = Read-Diagnostics; $d -and -not $d.dirty } 'native save completion')
}
function Block([string]$Id) {
    $p = Read-Project
    foreach ($section in $p.sections) {
        foreach ($block in $section.blocks) { if ($block.id -eq $Id) { return $block } }
    }
    return $null
}
function Run-Mcp([string]$Operation, $Arguments) {
    $suffix = [Guid]::NewGuid().ToString('N').Substring(0,8)
    $inputFile = Join-Path $RunDirectory ('mcp-' + $suffix + '-request.json')
    $outputFile = Join-Path $RunDirectory ('mcp-' + $suffix + '-response.json')
    $Arguments | ConvertTo-Json -Depth 70 | Set-Content -LiteralPath $inputFile -Encoding UTF8
    & $nodePath (Join-Path $ProjectRoot 'tests/winui/mcp-probe.mjs') $BackendRoot $RuntimeDirectory $Port $Operation $inputFile $outputFile
    if ($LASTEXITCODE -ne 0) { throw "Real MCP operation failed: $Operation" }
    return Get-Content -LiteralPath $outputFile -Raw -Encoding UTF8 | ConvertFrom-Json
}
function Start-Native {
    $startupClock=[Diagnostics.Stopwatch]::StartNew()
    if (Test-Path -LiteralPath $DiagnosticsPath) { Remove-Item -LiteralPath $DiagnosticsPath -Force }
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $ExecutablePath
    $startInfo.WorkingDirectory = [IO.Path]::GetDirectoryName($ExecutablePath)
    $startInfo.UseShellExecute = $false
    $startInfo.Arguments = '--workspace "' + $BackendRoot + '" --runtime "' + $RuntimeDirectory + '" --port ' + $Port + ' --project "' + $ProjectDirectory + '" --diagnostics "' + $DiagnosticsPath + '"'
    $script:application = [Diagnostics.Process]::Start($startInfo)
    [void](Wait-For { $application.Refresh(); $application.MainWindowHandle -ne [IntPtr]::Zero } 'real WinUI window startup' 40)
    $script:window = [Windows.Automation.AutomationElement]::FromHandle($application.MainWindowHandle)
    $script:window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern).SetWindowVisualState([Windows.Automation.WindowVisualState]::Maximized)
    [void](Wait-For { $d = Read-Diagnostics; $d -and $d.sectionId } 'native editor initialization' 40)
    $script:lastStartupMs=$startupClock.Elapsed.TotalMilliseconds
    $navigationClock=[Diagnostics.Stopwatch]::StartNew()
    if ((Read-Diagnostics).sectionId -ne $seed.sectionId) {
        $search = Require-Control 'ChapterSearch'
        $search.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($seed.sectionTitle)
        Choose-Section $seed.sectionId
        $search.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue('')
        [void](Wait-For { (Read-Diagnostics).sectionId -eq $seed.sectionId } 'selection retained after clearing section filter')
        $search.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($seed.sectionTitle)
        [void](Require-Control ('Section_' + $seed.sectionId))
    }
    $script:lastSectionLoadMs=$navigationClock.Elapsed.TotalMilliseconds
}
function Stop-Native {
    if ($application -and -not $application.HasExited) {
        [void]$application.CloseMainWindow()
        if (-not $application.WaitForExit(5000)) { $application.Kill(); [void]$application.WaitForExit(5000) }
    }
    $script:window = $null
}
function Plain-Node($Node) {
    if ($Node.type -eq 'text') { return $Node.text }
    $contentProperty = $Node.PSObject.Properties['content']
    if (-not $contentProperty) { return '' }
    return (($Node.content | ForEach-Object { Plain-Node $_ }) -join '')
}
function Fill-OwnedFilePicker([string]$Path) {
    $fileName = Wait-For {
        $foreground = [NativeAcceptanceInput]::GetForegroundWindow()
        if (-not (Is-OwnedWindow $foreground)) { return $null }
        $dialog = [Windows.Automation.AutomationElement]::FromHandle($foreground)
        foreach ($edit in $dialog.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)) {
            # The common Windows picker exposes its filename HWND as a generic
            # Pane on some Windows builds; its class/id remain Edit / 1148.
            if (($edit.Current.ClassName -eq 'Edit' -and $edit.Current.AutomationId -in @('1148', '1001')) -or
                ($edit.Current.ControlType -eq [Windows.Automation.ControlType]::Edit -and ($edit.Current.AutomationId -eq '1001' -or $edit.Current.Name -match '文件名|File name'))) { return $edit }
        }
        return $null
    } 'owned native Windows file picker'
    $value = $null
    if ($fileName.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$value)) { $value.SetValue($Path) }
    else {
        $inputHandle = [IntPtr]$fileName.Current.NativeWindowHandle
        if ($inputHandle -eq [IntPtr]::Zero -or -not (Is-OwnedWindow $inputHandle)) {
            $handles = New-Object 'Collections.Generic.List[System.IntPtr]'
            $findFileName = [NativeAcceptanceInput+WindowCallback]{
                param($handle, $unused)
                $class = New-Object Text.StringBuilder(128)
                [void][NativeAcceptanceInput]::GetClassName($handle, $class, $class.Capacity)
                if ($class.ToString() -eq 'Edit') {
                    $parent = [NativeAcceptanceInput]::GetParent($handle)
                    $grandparent = [NativeAcceptanceInput]::GetParent($parent)
                    if ([NativeAcceptanceInput]::GetDlgCtrlID($handle) -in @(1148, 1001) -or [NativeAcceptanceInput]::GetDlgCtrlID($parent) -eq 1148 -or [NativeAcceptanceInput]::GetDlgCtrlID($grandparent) -eq 1148) { $handles.Add($handle) }
                }
                return $true
            }
            [void][NativeAcceptanceInput]::EnumChildWindows([NativeAcceptanceInput]::GetForegroundWindow(), $findFileName, [IntPtr]::Zero)
            Assert-Condition ($handles.Count -eq 1) 'The owned native file picker must have exactly one filename Edit HWND.'
            $inputHandle = $handles[0]
        }
        Assert-Condition ($inputHandle -ne [IntPtr]::Zero -and (Is-OwnedWindow $inputHandle)) 'The native file picker field has no owned edit HWND.'
        # UIA's older managed Win32 proxy may expose no ValuePattern. Set the
        # real system filename Edit control, then submit with a real Enter key.
        [void][NativeAcceptanceInput]::SendMessage($inputHandle, 12, [IntPtr]::Zero, $Path)
    }
    try { $fileName.SetFocus() } catch { [void](Click-Element $fileName 'native picker filename') }
    Keyboard '{ENTER}'
}

function Tool([string]$Name, $Arguments) {
    $connection = Read-UnlockedJson (Join-Path $RuntimeDirectory 'connection.json')
    $body = @{name=$Name;args=$Arguments} | ConvertTo-Json -Depth 80 -Compress
    return Invoke-RestMethod -Uri ($connection.url + '/api/tool') -Method Post -Headers @{Authorization=('Bearer '+$connection.token)} -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
}
function Block([string]$Id) { return Tool 'read_block' @{block_id=$Id} }
try {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    Start-Native
    $loadMs = $clock.Elapsed.TotalMilliseconds
    $d = Read-Diagnostics
    $originalParagraph = Block $seed.paragraphId
    $originalTable = Block $seed.tableId
    Assert-Condition ((Require-Control 'SaveButton').Current.FrameworkId -eq 'XAML') 'WinUI XAML window expected'
    Assert-Condition ($d.tableCellCount -eq $seed.cellCount) 'All logical cells are rendered'
    Assert-Condition ($d.activeTextEditorCount -le $seed.baseTextEditors) 'Large table must not instantiate one rich editor per cell'
    Passed 'Large table opens with lightweight cells' @{loadMs=$loadMs;startupMs=$lastStartupMs;sectionNavigateMs=$lastSectionLoadMs;cells=$d.tableCellCount;activeTextEditors=$d.activeTextEditorCount}
    $beforeCompareCount = (Read-Diagnostics).rootComparisonCount
    $treeLabelBefore = [string]::Join(',',(Require-Control ('Section_'+$seed.sectionId)).GetRuntimeId())
    [void](Focus-Editor ('Text_' + $seed.paragraphId))
    Keyboard '^{END}'
    Keyboard '-native-v2-edit'
    Save-Document
    [void](Wait-For { (Block $seed.paragraphId).markdown.Contains('-native-v2-edit') } 'paragraph persisted by block ID')
    Assert-Condition ((Read-Diagnostics).rootComparisonCount -eq $beforeCompareCount) 'Ordinary paragraph save must not compare the adjacent table'
    $treeLabelAfter = [string]::Join(',',(Require-Control ('Section_'+$seed.sectionId)).GetRuntimeId())
    Assert-Condition ($treeLabelBefore -eq $treeLabelAfter) 'An ordinary paragraph save must retain its existing chapter navigation element'
    Passed 'Actual native typing saves stable paragraph ID' @{blockId=$seed.paragraphId;rootComparisonsBefore=$beforeCompareCount;rootComparisonsAfter=(Read-Diagnostics).rootComparisonCount;treeElementRetained=($treeLabelBefore -eq $treeLabelAfter)}
    if ($seed.PSObject.Properties['semanticProbe'] -and $seed.semanticProbe) {
        $probe=Block $seed.paragraphId
        Assert-Condition ((Plain-Node $probe.node) -eq ($seed.expectedText + '-native-v2-edit')) 'Exact visible text must survive without hidden HYPERLINK field codes'
        $marks=@($probe.node.content | Where-Object { $_.PSObject.Properties['marks'] } | ForEach-Object { $_.marks } | ForEach-Object { $_.type })
        Assert-Condition ($marks -contains 'superscript' -and $marks -contains 'subscript' -and $marks -contains 'link') 'Typing must preserve superscript/subscript/link semantics'
        Passed 'Native editing preserves superscript subscript and links' @{marks=$marks}
    }
    [void](Click-Control 'Ribbon_Undo')
    Save-Document
    [void](Wait-For { -not (Block $seed.paragraphId).markdown.Contains('-native-v2-edit') } 'block delta undo persisted')
    [void](Click-Control 'Ribbon_Redo')
    Save-Document
    [void](Wait-For { (Block $seed.paragraphId).markdown.Contains('-native-v2-edit') } 'block delta redo persisted')
    Passed 'Native block Undo and Redo' @{blockId=$seed.paragraphId}
    $paperScroll = (Require-Control 'PaperScroll').GetCurrentPattern([Windows.Automation.ScrollPattern]::Pattern)
    $paperScroll.SetScrollPercent(-1,0)
    Start-Sleep -Milliseconds 250
    [void](Click-Control ('Cell_' + $seed.cellId))
    # Use the supported keyboard entry so UIA traversal time cannot break the system double-click interval.
    Keyboard '{F2}'
    [void](Focus-Editor ('Text_' + $seed.cellParagraphId))
    Keyboard '^{END}'
    Keyboard '-cell-v2-edit'
    Save-Document
    [void](Wait-For { (Block $seed.tableId).markdown.Contains('-cell-v2-edit') } 'large table active cell save')
    $d = Read-Diagnostics
    Assert-Condition ($d.activeTextEditorCount -le ($seed.baseTextEditors+1)) 'Only active cell should create an editor'
    Passed 'Large table activates edits and saves one cell' @{tableId=$seed.tableId;cellCount=$d.tableCellCount;activeTextEditors=$d.activeTextEditorCount}
    $scroll = (Require-Control 'PaperScroll').GetCurrentPattern([Windows.Automation.ScrollPattern]::Pattern)
    $scroll.SetScrollPercent(-1,100)
    [void](Wait-For { $scroll.SetScrollPercent(-1,100); $currentScroll=(Require-Control 'PaperScroll').GetCurrentPattern([Windows.Automation.ScrollPattern]::Pattern); $currentScroll.Current.VerticalScrollPercent -gt 90 } 'large table scroll reached end')
    $scroll.SetScrollPercent(-1,0)
    Passed 'Large table scrolls end to end' @{cellCount=$d.tableCellCount}
    Stop-Native
    Start-Native
    [void](Wait-For { (Block $seed.tableId).markdown.Contains('-cell-v2-edit') } 'cell recovered after reopen')
    Passed 'Saved large table restores on native reopen' @{tableId=$seed.tableId;startupMs=$lastStartupMs;sectionNavigateMs=$lastSectionLoadMs;cells=(Read-Diagnostics).tableCellCount;activeTextEditors=(Read-Diagnostics).activeTextEditorCount}
    if ($seed.PSObject.Properties['restoreAfter'] -and $seed.restoreAfter) {
        $current = Block $seed.paragraphId
        [void](Tool 'update_block' @{block_id=$seed.paragraphId;expected_revision=$current.revision;node=$originalParagraph.node})
        $current = Block $seed.tableId
        [void](Tool 'update_block' @{block_id=$seed.tableId;expected_revision=$current.revision;node=$originalTable.node})
        [void](Wait-For { -not (Block $seed.tableId).markdown.Contains('-cell-v2-edit') } 'test markers restored in isolated copy')
        Assert-Condition (((Block $seed.paragraphId).content | ConvertTo-Json -Depth 100 -Compress) -eq ($originalParagraph.content | ConvertTo-Json -Depth 100 -Compress)) 'Paragraph semantic content must match the original exactly after restoration'
        Assert-Condition (((Block $seed.tableId).content | ConvertTo-Json -Depth 100 -Compress) -eq ($originalTable.content | ConvertTo-Json -Depth 100 -Compress)) 'All table cells and marks must match the original exactly after restoration'
        $restoredOriginals = $true
        Passed 'Original content restored after real-project UI probe' @{paragraphId=$seed.paragraphId;tableId=$seed.tableId}
    }
    if ($seed.PSObject.Properties['exportViaUi'] -and $seed.exportViaUi) {
        $exportPath=Join-Path $RunDirectory 'native-export.docx'
        [void](Click-Control 'ExportButton')
        [void](Click-Name '选择保存位置')
        Fill-OwnedFilePicker $exportPath
        [void](Wait-For { (Test-Path -LiteralPath $exportPath) -and (Get-Item -LiteralPath $exportPath).Length -gt 0 } 'DOCX exported through native button' 40)
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive=[IO.Compression.ZipFile]::OpenRead($exportPath)
        try { Assert-Condition ($null -ne $archive.GetEntry('word/document.xml') -and $null -ne $archive.GetEntry('[Content_Types].xml')) 'Native export must be a Word DOCX archive' } finally { $archive.Dispose() }
        Passed 'Native Word export button writes DOCX' @{file=$exportPath;bytes=(Get-Item -LiteralPath $exportPath).Length}
    }
    Stop-Native
} catch {
    $failure=$_.Exception.ToString()
    if ($window) {
        try {
            $tree=Find-Control 'ChapterTree'
            $items=@($tree.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition) | ForEach-Object { @{name=$_.Current.Name;id=$_.Current.AutomationId;type=$_.Current.ControlType.ProgrammaticName;bounds=$_.Current.BoundingRectangle.ToString();patterns=@($_.GetSupportedPatterns() | ForEach-Object {$_.ProgrammaticName})} })
            $items | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $RunDirectory 'tree-debug.json') -Encoding utf8
        } catch {}
    }
    Write-Error $failure -ErrorAction Continue
} finally {
    if (-not $restoredOriginals -and $originalParagraph -and $originalTable -and $seed.PSObject.Properties['restoreAfter'] -and $seed.restoreAfter) {
        try {
            $current=Block $seed.paragraphId
            [void](Tool 'update_block' @{block_id=$seed.paragraphId;expected_revision=$current.revision;node=$originalParagraph.node})
            $current=Block $seed.tableId
            [void](Tool 'update_block' @{block_id=$seed.tableId;expected_revision=$current.revision;node=$originalTable.node})
        } catch { $failure += "`nFailed to restore isolated test content: " + $_.Exception.Message }
    }
    Stop-Native
    Save-Results
    if (Test-Path -LiteralPath (Join-Path $RuntimeDirectory 'connection.json')) {
        $connection = Read-UnlockedJson (Join-Path $RuntimeDirectory 'connection.json')
        $service = Get-Process -Id $connection.pid -ErrorAction SilentlyContinue
        if ($service) { Stop-Process -Id $service.Id }
    }
}
if ($failure) { exit 1 }
