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
    public delegate bool WindowCallback(IntPtr window, IntPtr parameter);
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
$nodePath = Join-Path $BackendRoot 'node.exe'
$checks = New-Object 'Collections.Generic.List[object]'
$application = $null
$window = $null
$seed = Get-Content -LiteralPath $SeedPath -Raw -Encoding UTF8 | ConvertFrom-Json
$failure = $null
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
            [void][NativeAcceptanceInput]::ShowWindow($application.MainWindowHandle, 9)
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
        [void][NativeAcceptanceInput]::SetCursorPos([int]($rectangle.X + $rectangle.Width/2), [int]($rectangle.Y + $rectangle.Height/2))
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
function Keyboard([string]$Keys) { Foreground-App; [Windows.Forms.SendKeys]::SendWait($Keys); Start-Sleep -Milliseconds 200 }
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
    [void](Click-Control ('Section_' + $SectionId))
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
    if (Test-Path -LiteralPath $DiagnosticsPath) { Remove-Item -LiteralPath $DiagnosticsPath -Force }
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $ExecutablePath
    $startInfo.WorkingDirectory = [IO.Path]::GetDirectoryName($ExecutablePath)
    $startInfo.UseShellExecute = $false
    $startInfo.Arguments = '--workspace "' + $BackendRoot + '" --runtime "' + $RuntimeDirectory + '" --port ' + $Port + ' --project "' + $ProjectDirectory + '" --diagnostics "' + $DiagnosticsPath + '"'
    $script:application = [Diagnostics.Process]::Start($startInfo)
    [void](Wait-For { $application.Refresh(); $application.MainWindowHandle -ne [IntPtr]::Zero } 'real WinUI window startup' 40)
    $script:window = [Windows.Automation.AutomationElement]::FromHandle($application.MainWindowHandle)
    [void](Wait-For { $d = Read-Diagnostics; $d -and $d.sectionId } 'native editor initialization' 40)
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

try {
    Start-Native
    $nativeRoot = Require-Control 'SaveButton'
    Assert-Condition ($nativeRoot.Current.FrameworkId -eq 'XAML') ('The active editor is not a native XAML UI: ' + $nativeRoot.Current.FrameworkId)
    $tools = Run-Mcp 'list' @{}
    if (-not $ResumeAfterTables) {
    Passed 'Real WinUI window and bundled MCP initialize/tools/list' @{ processId = $application.Id; framework = $nativeRoot.Current.FrameworkId; toolCount = $tools.tools.Count }

    Choose-Section $seed.paragraphSectionId
    $editor = Focus-Editor ('Text_' + $seed.paragraphId)
    Assert-Condition ($editor.Current.FrameworkId -eq 'XAML') 'The paragraph editor is not a native XAML control.'
    $marker = ' native-keyboard-edit'
    Keyboard '^{END}'
    Keyboard $marker
    Save-Document
    [void](Wait-For { (Block $seed.paragraphId).markdown.Contains($marker) } 'native keyboard edit in authoritative project')
    $after = Read-Project
    $sectionAfter = $after.sections | Where-Object { $_.id -eq $seed.paragraphSectionId }
    foreach ($oldBlock in $seed.originalParagraphSection.blocks) {
        if ($oldBlock.id -eq $seed.paragraphId) { continue }
        $unchanged = $sectionAfter.blocks | Where-Object { $_.id -eq $oldBlock.id }
        Assert-Condition (($unchanged | ConvertTo-Json -Depth 70 -Compress) -eq ($oldBlock | ConvertTo-Json -Depth 70 -Compress)) ('Editing one paragraph changed an unrelated block: ' + $oldBlock.id)
    }
    Passed 'Native RichEditBox keyboard edit saves one block with stable ID' @{ blockId = $seed.paragraphId; editorClass = $editor.Current.ClassName; marker = $marker }

    [void](Click-Control 'Ribbon_Undo')
    Save-Document
    [void](Wait-For { -not (Block $seed.paragraphId).markdown.Contains($marker) } 'native Undo')
    [void](Click-Control 'Ribbon_Redo')
    Save-Document
    [void](Wait-For { (Block $seed.paragraphId).markdown.Contains($marker) } 'native Redo')
    Passed 'Native ribbon Undo/Redo keeps block identity' @{ blockId = $seed.paragraphId }

    [void](Focus-Editor ('Text_' + $seed.paragraphId))
    Keyboard '^{END}'
    Keyboard ' persistent-focus-A'
    Start-Sleep -Milliseconds 900
    # Do not refocus: the second phrase must reach the same editor after autosave.
    Keyboard '-B'
    Save-Document
    [void](Wait-For { (Block $seed.paragraphId).markdown.Contains('persistent-focus-A-B') } 'typing focus retained across automatic save')
    Passed 'Native typing continues after autosave without refocusing' @{ blockId = $seed.paragraphId; marker = 'persistent-focus-A-B' }

    $fresh = Block $seed.paragraphId
    [void](Run-Mcp 'replace_text' @{ block_id = $seed.paragraphId; expected_revision = $fresh.revision; old_text = '1.6 MPa'; new_text = '1.8 MPa' })
    [void](Wait-For { $d = Read-Diagnostics; $d -and (($d.localNodes | ConvertTo-Json -Depth 70 -Compress).Contains('1.8 MPa')) } 'MCP update visible in native controls')
    $nativeTextPattern = $null
    $editor = Require-Control ('Text_' + $seed.paragraphId)
    $nativeText = $null
    if ($editor.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern, [ref]$nativeTextPattern)) { $nativeText = $nativeTextPattern.DocumentRange.GetText(-1) }
    elseif ($editor.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$nativeTextPattern)) { $nativeText = $nativeTextPattern.Current.Value }
    Assert-Condition ($nativeText -and $nativeText.Contains('1.8 MPa')) 'MCP edit reached diagnostics but did not reach the actual native RichEditBox text.'
    Passed 'Real MCP replacement refreshes native RichEditBox text' @{ blockId = $seed.paragraphId; nativeText = $nativeText }

    [void](Focus-Editor ('Text_' + $seed.paragraphId))
    Keyboard '^{HOME}^+{END}'
    Keyboard '^b'
    Save-Document
    $boldBlock = Block $seed.paragraphId
    $boldTextNodes = @($boldBlock.node.content | Where-Object { $_.type -eq 'text' -and $_.PSObject.Properties['marks'] -and @($_.marks | Where-Object { $_.type -eq 'bold' }).Count -gt 0 })
    $allTextNodes = @($boldBlock.node.content | Where-Object { $_.type -eq 'text' })
    Assert-Condition ($boldTextNodes.Count -gt 0 -and $boldTextNodes.Count -eq $allTextNodes.Count) 'Native Ctrl+B did not make the entire selected paragraph bold.'
    Passed 'Native paragraph selection and Ctrl+B persist structured bold marks' @{ blockId = $seed.paragraphId; boldRuns = $boldTextNodes.Count }

    $beforeFontSection = (Read-Project).sections | Where-Object { $_.id -eq $seed.paragraphSectionId }
    Select-ComboItem 'FontFamily' 'Arial'
    Select-ComboItem 'FontSize' '16'
    [void](Click-Control 'Ribbon_ApplyFont')
    Save-Document
    $fontBlock = Block $seed.paragraphId
    Assert-Condition ($fontBlock.node.attrs.PSObject.Properties['fontFamily'] -and $fontBlock.node.attrs.PSObject.Properties['fontSize'] -and $fontBlock.node.attrs.fontFamily -eq 'Arial' -and $fontBlock.node.attrs.fontSize -eq 16) 'Native font family and font size did not persist in the explicitly selected structured paragraph.'
    $afterFontSection = (Read-Project).sections | Where-Object { $_.id -eq $seed.paragraphSectionId }
    foreach ($oldBlock in $beforeFontSection.blocks) {
        if ($oldBlock.id -eq $seed.paragraphId) { continue }
        $unchanged = $afterFontSection.blocks | Where-Object { $_.id -eq $oldBlock.id }
        Assert-Condition (($unchanged | ConvertTo-Json -Depth 70 -Compress) -eq ($oldBlock | ConvertTo-Json -Depth 70 -Compress)) ('Native font command changed a different paragraph: ' + $oldBlock.id)
    }
    $boldBlock = $fontBlock
    Passed 'Native font controls persist family and size in the paragraph' @{ blockId = $seed.paragraphId; family = 'Arial'; size = 16 }

    [void](Focus-Editor ('Text_' + $seed.paragraphId))
    $beforeCopySection = (Read-Project).sections | Where-Object { $_.id -eq $seed.paragraphSectionId }
    [void](Click-Control 'CopyBlockButton')
    Save-Document
    $afterCopySection = (Read-Project).sections | Where-Object { $_.id -eq $seed.paragraphSectionId }
    Assert-Condition (($afterCopySection | ConvertTo-Json -Depth 70 -Compress) -eq ($beforeCopySection | ConvertTo-Json -Depth 70 -Compress)) 'Native Copy Block must only write the clipboard and leave source blocks unchanged.'
    Passed 'Native Copy Block writes clipboard without adding content' @{ original = $seed.paragraphId; blockCount = $afterCopySection.blocks.Count }
    [void](Click-Control 'PasteBlockButton')
    Save-Document
    $copiedSection = (Read-Project).sections | Where-Object { $_.id -eq $seed.paragraphSectionId }
    $copied = @($copiedSection.blocks | Where-Object { $_.id -ne $seed.paragraphId -and $_.markdown -eq $boldBlock.markdown })
    Assert-Condition ($copied.Count -eq 1) 'Native Paste Block did not create exactly one fresh block with the same clipboard content.'
    $copyId = $copied[0].id
    Assert-Condition ($copyId -ne $seed.paragraphId) 'Native copy reused an existing block ID.'
    Passed 'Native Paste Block creates fresh identity and retains content' @{ original = $seed.paragraphId; copy = $copyId }

    [void](Focus-Editor ('Text_' + $copyId))
    $moveTarget = Require-Control 'MoveTarget'
    Foreground-App
    $moveTarget.SetFocus()
    # UI targets retain project order and exclude the current section.
    Keyboard '{HOME}{DOWN 2}{ENTER}'
    [void](Click-Control 'MoveBlockButton')
    [void](Wait-For { (Block $copyId).sectionId -eq $seed.richSectionId } 'native block move to another chapter')
    [void](Click-Control 'Ribbon_Undo')
    [void](Wait-For { (Block $copyId).sectionId -eq $seed.paragraphSectionId } 'native cross-chapter move Undo')
    [void](Click-Control 'Ribbon_Redo')
    [void](Wait-For { (Block $copyId).sectionId -eq $seed.richSectionId } 'native cross-chapter move Redo')
    Passed 'Native cross-chapter move Undo/Redo retains copied block identity' @{ blockId = $copyId; from = $seed.paragraphSectionId; to = $seed.richSectionId }

    Choose-Section $seed.richSectionId
    $rich = (Read-Project).sections | Where-Object { $_.id -eq $seed.richSectionId }
    $table = $rich.blocks | Where-Object { $_.type -eq 'table' } | Select-Object -First 1
    $image = $rich.blocks | Where-Object { $_.type -eq 'image' } | Select-Object -First 1
    $firstImportedCellParagraph = $table.node.content[0].content[0].content | Where-Object { $_.type -in @('paragraph', 'heading') } | Select-Object -First 1
    [void](Require-Control ('Text_' + $firstImportedCellParagraph.attrs.id))
    [void](Require-Control ('Image_' + $image.id))
    $imageDiagnostics = Wait-For { $d = Read-Diagnostics; if ($d.imageCount -gt 0 -and $d.loadedImageCount -eq $d.imageCount -and @($d.failedImages).Count -eq 0) { return $d } } 'native imported images decoded successfully'
    Passed 'Native chapter navigation renders imported merged table and decodes images' @{ sectionId = $seed.richSectionId; tableId = $table.id; imageId = $image.id; decodedImages = $imageDiagnostics.loadedImageCount }

    [void](Focus-Editor ('Text_' + $copyId))
    Keyboard '^{END}'
    Keyboard '{ENTER}'
    # Enter must focus the freshly created native editor before further input.
    Keyboard 'new-paragraph-after-enter'
    Save-Document
    $richAfterSplit = (Read-Project).sections | Where-Object { $_.id -eq $seed.richSectionId }
    $newParagraph = $richAfterSplit.blocks | Where-Object { $_.id -ne $copyId -and $_.markdown.Contains('new-paragraph-after-enter') } | Select-Object -First 1
    Assert-Condition ($null -ne $newParagraph) 'Typing immediately after Enter did not reach the new native paragraph editor.'
    $splitId = $newParagraph.id
    Assert-Condition ($splitId -ne $copyId -and $null -ne (Block $copyId)) 'Paragraph split did not retain the original ID and allocate a new right-side ID.'
    [void](Focus-Editor ('Text_' + $splitId))
    Keyboard '^{HOME}{BACKSPACE}'
    Save-Document
    Assert-Condition ($null -eq (Block $splitId) -and (Block $copyId).markdown.Contains('new-paragraph-after-enter')) 'Native Backspace join did not preserve the left paragraph identity and both texts.'
    [void](Click-Control 'Ribbon_Undo')
    Save-Document
    Assert-Condition ($null -ne (Block $splitId)) 'Undoing the native paragraph join changed or lost the right-side ID.'
    [void](Click-Control 'Ribbon_Redo')
    Save-Document
    Assert-Condition ($null -eq (Block $splitId) -and $null -ne (Block $copyId)) 'Redoing the native paragraph join changed the identity rule.'
    Passed 'Native Enter typing, Backspace join, and Undo/Redo preserve paragraph identity' @{ left = $copyId; right = $splitId }

    [void](Click-Control 'InsertTab')
    $existingIds = @($rich.blocks.id)
    [void](Click-Control 'Ribbon_InsertTable')
    Save-Document
    $rich = (Read-Project).sections | Where-Object { $_.id -eq $seed.richSectionId }
    $newTable = $rich.blocks | Where-Object { $_.type -eq 'table' -and $_.id -notin $existingIds } | Select-Object -First 1
    Assert-Condition ($null -ne $newTable) 'Native Insert Table did not create a structured table block.'
    $tableId = $newTable.id
    $rowCount = $newTable.node.content.Count
    $columnCount = $newTable.node.content[0].content.Count
    $cellId = $newTable.node.content[0].content[0].attrs.id
    $paragraphId = $newTable.node.content[0].content[0].content[0].attrs.id
    [void](Focus-Editor ('Text_' + $paragraphId))
    Keyboard 'native-table-cell'
    Save-Document
    [void](Wait-For { (Plain-Node (Block $tableId).node).Contains('native-table-cell') } 'native table cell keyboard edit')
    [void](Focus-Editor ('Text_' + $paragraphId))
    [void](Click-Control 'Ribbon_AddRow')
    Save-Document
    Assert-Condition ((Block $tableId).node.content.Count -eq ($rowCount + 1)) 'Native Add Row did not add a row.'
    [void](Click-Control 'Ribbon_DeleteRow')
    Save-Document
    Assert-Condition ((Block $tableId).node.content.Count -eq $rowCount) 'Native Delete Row did not restore the expected row count.'
    $newTable = Block $tableId
    $paragraphId = $newTable.node.content[0].content[0].content[0].attrs.id
    [void](Focus-Editor ('Text_' + $paragraphId))
    [void](Click-Control 'Ribbon_AddColumn')
    Save-Document
    Assert-Condition ((Block $tableId).node.content[0].content.Count -eq ($columnCount + 1)) 'Native Add Column did not add a column.'
    [void](Click-Control 'Ribbon_DeleteColumn')
    Save-Document
    Assert-Condition ((Block $tableId).node.content[0].content.Count -eq $columnCount) 'Native Delete Column did not restore the expected column count.'
    Passed 'Native table insertion, cell typing, and row/column add/delete' @{ tableId = $tableId; originalRows = $rowCount; originalColumns = $columnCount }

    $newTable = Block $tableId
    $paragraphId = $newTable.node.content[0].content[0].content[0].attrs.id
    [void](Focus-Editor ('Text_' + $paragraphId))
    $adjacentParagraphId = $newTable.node.content[0].content[1].content[0].attrs.id
    Shift-Click-Control ('Text_' + $adjacentParagraphId)
    [void](Click-Control 'Ribbon_MergeCells')
    Save-Document
    $mergedTable = Block $tableId
    $mergedCell = $mergedTable.node.content[0].content[0]
    Assert-Condition ($mergedCell.attrs.colspan -gt 1 -or $mergedCell.attrs.rowspan -gt 1) 'Native Merge Cells did not create a spanning cell.'
    $mergedParagraph = $mergedCell.content | Where-Object { $_.type -in @('paragraph', 'heading') } | Select-Object -First 1
    [void](Focus-Editor ('Text_' + $mergedParagraph.attrs.id))
    [void](Click-Control 'Ribbon_SplitCell')
    Save-Document
    $splitCell = (Block $tableId).node.content[0].content[0]
    Assert-Condition ($splitCell.attrs.colspan -eq 1 -and $splitCell.attrs.rowspan -eq 1) 'Native Split Cell did not restore a unit cell.'
    Passed 'Native table merge/split preserves table identity' @{ tableId = $tableId; cellId = $cellId }
    } else {
        Choose-Section $seed.richSectionId
        [void](Click-Control 'InsertTab')
        $existingTables = @((Read-Project).sections | Where-Object { $_.id -eq $seed.richSectionId } | ForEach-Object { $_.blocks } | Where-Object { $_.type -eq 'table' })
        $resumeParagraph = $existingTables[-1].node.content[0].content[0].content | Where-Object { $_.type -eq 'paragraph' } | Select-Object -First 1
        [void](Focus-Editor ('Text_' + $resumeParagraph.attrs.id))
    }

    $beforeImages = @((Read-Project).sections | Where-Object { $_.id -eq $seed.richSectionId } | ForEach-Object { $_.blocks } | Where-Object { $_.type -eq 'image' }).Count
    [void](Click-Control 'Ribbon_InsertImage')
    Fill-OwnedFilePicker ([IO.Path]::GetFullPath((Join-Path $ProjectRoot 'tests/fixtures/b/diagram.png')))
    [void](Wait-For { $d = Read-Diagnostics; @($d.localNodes | Where-Object { $_.type -eq 'image' }).Count -gt $beforeImages } 'native image import')
    Save-Document
    $afterImages = @((Read-Project).sections | Where-Object { $_.id -eq $seed.richSectionId } | ForEach-Object { $_.blocks } | Where-Object { $_.type -eq 'image' })
    Assert-Condition ($afterImages.Count -eq ($beforeImages + 1)) 'Native Insert Image did not append one image block.'
    foreach ($insertedImage in $afterImages) {
        Assert-Condition (Test-Path -LiteralPath (Join-Path $ProjectDirectory $insertedImage.node.attrs.src) -PathType Leaf) ('Native image references a missing asset: ' + $insertedImage.id)
    }
    $imageDiagnostics = Wait-For { $d = Read-Diagnostics; if ($d.imageCount -gt 0 -and $d.loadedImageCount -eq $d.imageCount -and @($d.failedImages).Count -eq 0) { return $d } } 'new native image decoded successfully'
    Passed 'Native Windows image picker imports and decodes a local asset' @{ rootImageCount = $afterImages.Count; decodedImages = $imageDiagnostics.loadedImageCount }

    [void](Click-Control 'LayoutTab')
    [void](Focus-EditableControl 'StyleSize')
    Keyboard '^a'
    Keyboard '15'
    Keyboard '{TAB}'
    [void](Click-Control 'SaveStylesButton')
    [void](Wait-For { $d = Read-Diagnostics; $d -and -not $d.styleDirty -and $d.notice -and $d.notice.Contains('样式已保存') } 'native semantic body font size save')
    Assert-Condition ((Read-Project).styles.semantic.body.font.sizePt -eq 15) 'Native semantic body font size did not persist as 15pt.'
    Passed 'Native styles panel changes persisted semantic rules' @{ field = 'StyleSize'; value = 15 }

    Choose-Section $seed.paragraphSectionId
    Save-Document
    $beforeRestart = Read-Project
    Stop-Native
    Start-Native
    Choose-Section $seed.paragraphSectionId
    $afterRestart = Read-Project
    Assert-Condition (($beforeRestart | ConvertTo-Json -Depth 70 -Compress) -eq ($afterRestart | ConvertTo-Json -Depth 70 -Compress)) 'Restart changed the authoritative project snapshot.'
    $restoredEditor = Require-Control ('Text_' + $seed.paragraphId)
    Passed 'Closing and reopening native application restores content, styles and IDs' @{ blockId = $seed.paragraphId; revision = $afterRestart.revision; editorClass = $restoredEditor.Current.ClassName }

    [void](Click-Control 'ExportButton')
    [void](Click-Name '选择保存位置')
    $nativeArchivePath = Join-Path $RunDirectory 'native-export.zip'
    Fill-OwnedFilePicker $nativeArchivePath
    $nativeArchive = Wait-For { Get-Item -LiteralPath $nativeArchivePath -ErrorAction SilentlyContinue } 'native export package'
    $exportEvidence = Join-Path $RunDirectory 'native-export-result.json'
    & $nodePath (Join-Path $ProjectRoot 'tests/winui/verify-export.mjs') $BackendRoot $nativeArchive.FullName $exportEvidence
    if ($LASTEXITCODE -ne 0) { throw 'Native export package verification failed.' }
    Passed 'Native Export button produces self-contained content/style/image package' (Get-Content -LiteralPath $exportEvidence -Raw -Encoding UTF8 | ConvertFrom-Json)
} catch {
    $failure = $_.Exception.Message
    $checks.Add([pscustomobject]@{ name = 'Native UI verification stopped'; status = 'failed'; evidence = $failure })
    Write-Error $_ -ErrorAction Continue
} finally {
    Stop-Native
    # Only stop the backend whose connection file belongs to this isolated test.
    $connectionPath = Join-Path $RuntimeDirectory 'connection.json'
    if (Test-Path -LiteralPath $connectionPath) {
        try {
            $connection = Get-Content -LiteralPath $connectionPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $serviceProcess = Get-Process -Id $connection.pid -ErrorAction SilentlyContinue
            if ($serviceProcess -and [IO.Path]::GetFullPath($serviceProcess.Path) -eq [IO.Path]::GetFullPath($nodePath)) {
                $commandLine = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $serviceProcess.Id)).CommandLine
                if ($commandLine -and $commandLine.Contains($BackendRoot) -and $commandLine.Contains('service.js')) { $serviceProcess.Kill() }
            }
        } catch {}
    }
    Save-Results
}
if ($failure) { exit 1 }
