[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ExecutablePath,
    [Parameter(Mandatory=$true)][string]$BackendRoot,
    [string]$ProjectRoot,
    [string]$RunDirectory,
    [int]$Port = 43281,
    [switch]$SelectionInteractions
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $ProjectRoot) { $ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..')) }
if (-not $RunDirectory) { $RunDirectory = Join-Path $ProjectRoot ('artifacts/clipboard-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)) }
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ClipboardAcceptanceInput {
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
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint first, uint second, bool attach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
'@
$RunDirectory = [IO.Path]::GetFullPath($RunDirectory)
$ProjectDirectory = Join-Path $RunDirectory 'project'
$RuntimeDirectory = Join-Path $RunDirectory 'runtime'
$DiagnosticsPath = Join-Path $RunDirectory 'diagnostics.json'
$SeedPath = Join-Path $RunDirectory 'seed.json'
if (Test-Path -LiteralPath $RunDirectory) { throw 'Choose a new run directory; this test never opens an existing project.' }
New-Item -ItemType Directory -Path $RunDirectory -Force | Out-Null
$nodePath = if (Test-Path -LiteralPath (Join-Path $BackendRoot 'node.exe')) { Join-Path $BackendRoot 'node.exe' } else { (Get-Command node.exe -ErrorAction Stop).Source }
& $nodePath (Join-Path $ProjectRoot 'tests/winui/prepare-clipboard-v2.mjs') $ProjectDirectory $SeedPath
if ($LASTEXITCODE -ne 0) { throw 'Creating the isolated clipboard fixture failed.' }
$seed = Get-Content -LiteralPath $SeedPath -Raw -Encoding UTF8 | ConvertFrom-Json
$checks = New-Object 'Collections.Generic.List[object]'
$application = $null
$window = $null
$failure = $null
$servicePid = $null
$startedApplicationIds = New-Object 'Collections.Generic.List[int]'
$originalClipboard = [Windows.Forms.Clipboard]::GetDataObject()

function Save-Results {
    [ordered]@{checks=$checks;error=$failure;project=$ProjectDirectory;runtime=$RuntimeDirectory;diagnostics=$DiagnosticsPath;port=$Port;testApplicationPids=$startedApplicationIds;testServicePid=$servicePid} |
        ConvertTo-Json -Depth 70 | Set-Content -LiteralPath (Join-Path $RunDirectory 'clipboard-ui-results.json') -Encoding UTF8
}
function Passed([string]$Name, $Evidence) {
    $checks.Add([pscustomobject]@{name=$Name;status='passed';evidence=$Evidence})
    Write-Host "PASS $Name"
    Save-Results
}
function Assert-Condition([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Wait-For([scriptblock]$Condition, [string]$Description, [int]$Seconds=20) {
    $deadline=[DateTime]::UtcNow.AddSeconds($Seconds)
    $lastError=''
    do {
        if ($application -and $application.HasExited) { throw "Test application exited while waiting for $Description." }
        try { $value=& $Condition; if ($value) { return $value } } catch { $lastError=$_.Exception.Message }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out waiting for $Description. $lastError"
}
function Read-Json([string]$Path) {
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $reader=New-Object IO.StreamReader($stream,[Text.Encoding]::UTF8,$true)
    try { return $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose();$stream.Dispose() }
}
function Read-Diagnostics { if (Test-Path -LiteralPath $DiagnosticsPath) { return Read-Json $DiagnosticsPath }; return $null }
function Tool([string]$Name, $Arguments) {
    $connection=Read-Json (Join-Path $RuntimeDirectory 'connection.json')
    Assert-Condition ($connection.url -eq ('http://127.0.0.1:'+$Port)) 'Only the isolated test service may receive tool requests.'
    $body=@{name=$Name;args=$Arguments} | ConvertTo-Json -Depth 80 -Compress
    return Invoke-RestMethod -Uri ($connection.url+'/api/tool') -Method Post -Headers @{Authorization=('Bearer '+$connection.token)} -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
}
function Read-Section([string]$Id) { return Tool 'read_section' @{section_id=$Id} }
function Block([string]$Id) { return Tool 'read_block' @{block_id=$Id} }
function Json($Value) { return ConvertTo-Json -InputObject $Value -Depth 90 -Compress }
function Semantic-Blocks($Blocks) { return Json @($Blocks | ForEach-Object { [ordered]@{id=$_.id;node=$_.node} }) }
function Plain-Node($Node) {
    if ($Node.type -eq 'text') { return $Node.text }
    if (-not $Node.PSObject.Properties['content']) { return '' }
    return (($Node.content | ForEach-Object { Plain-Node $_ }) -join '')
}
function Inline-Text($Node) {
    if ($Node.type -eq 'text') { return $Node.text }
    if ($Node.type -eq 'hardBreak') { return "`n" }
    if (-not $Node.PSObject.Properties['content']) { return '' }
    return (($Node.content | ForEach-Object { Inline-Text $_ }) -join '')
}
function Without-Ids($Node) {
    $clone=Json $Node | ConvertFrom-Json
    function Clear-NodeIds($Current) {
        if ($Current.PSObject.Properties['attrs']) { $Current.attrs.PSObject.Properties.Remove('id') }
        if ($Current.PSObject.Properties['content']) { foreach ($child in $Current.content) { Clear-NodeIds $child } }
    }
    Clear-NodeIds $clone
    return Json $clone
}
function Node-Ids($Node) {
    if ($Node.PSObject.Properties['attrs'] -and $Node.attrs.PSObject.Properties['id']) { $Node.attrs.id }
    if ($Node.PSObject.Properties['content']) { foreach ($child in $Node.content) { Node-Ids $child } }
}
function Assert-FreshCopy($Original,$Copy) {
    Assert-Condition ($Original.id -ne $Copy.id) 'A pasted root must have a fresh ID.'
    Assert-Condition ((Without-Ids $Original.node) -eq (Without-Ids $Copy.node)) 'Copied semantic content, formatting and table spans must remain exact.'
    $oldIds=@(Node-Ids $Original.node)
    foreach ($newId in @(Node-Ids $Copy.node)) { Assert-Condition ($oldIds -notcontains $newId) ('Pasted descendant reused an original ID: '+$newId) }
}
function Find-Control([string]$Id) {
    if (-not $window) { return $null }
    $condition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::AutomationIdProperty,$Id)
    return $window.FindFirst([Windows.Automation.TreeScope]::Descendants,$condition)
}
function Require-Control([string]$Id) { return Wait-For { Find-Control $Id } "native control $Id" }
function Owns-Foreground {
    [uint32]$ownerProcess=0
    [void][ClipboardAcceptanceInput]::GetWindowThreadProcessId([ClipboardAcceptanceInput]::GetForegroundWindow(),[ref]$ownerProcess)
    return $application -and $ownerProcess -eq $application.Id
}
function Foreground-App {
    $application.Refresh()
    if (-not (Owns-Foreground)) {
        [uint32]$foregroundProcess=0
        $foregroundThread=[ClipboardAcceptanceInput]::GetWindowThreadProcessId([ClipboardAcceptanceInput]::GetForegroundWindow(),[ref]$foregroundProcess)
        [uint32]$targetProcess=0
        $targetThread=[ClipboardAcceptanceInput]::GetWindowThreadProcessId($application.MainWindowHandle,[ref]$targetProcess)
        $currentThread=[ClipboardAcceptanceInput]::GetCurrentThreadId()
        if ($foregroundThread -and $foregroundThread -ne $currentThread) { [void][ClipboardAcceptanceInput]::AttachThreadInput($currentThread,$foregroundThread,$true) }
        if ($targetThread -and $targetThread -ne $currentThread -and $targetThread -ne $foregroundThread) { [void][ClipboardAcceptanceInput]::AttachThreadInput($currentThread,$targetThread,$true) }
        try {
            [void][ClipboardAcceptanceInput]::ShowWindow($application.MainWindowHandle,5)
            [void][ClipboardAcceptanceInput]::BringWindowToTop($application.MainWindowHandle)
            [void][ClipboardAcceptanceInput]::SetForegroundWindow($application.MainWindowHandle)
            Start-Sleep -Milliseconds 150
        } finally {
            if ($targetThread -and $targetThread -ne $currentThread -and $targetThread -ne $foregroundThread) { [void][ClipboardAcceptanceInput]::AttachThreadInput($currentThread,$targetThread,$false) }
            if ($foregroundThread -and $foregroundThread -ne $currentThread) { [void][ClipboardAcceptanceInput]::AttachThreadInput($currentThread,$foregroundThread,$false) }
        }
    }
    Assert-Condition (Owns-Foreground) 'The test window did not receive foreground focus; keyboard and pointer input were cancelled.'
}
function Click-Element($Control,[bool]$PointerOnly=$false) {
    Foreground-App
    $pattern=$null
    if (-not $PointerOnly -and $Control.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) { $pattern.Invoke() }
    elseif (-not $PointerOnly -and $Control.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)) { $pattern.Select() }
    else {
        $rectangle=$Control.Current.BoundingRectangle
        Assert-Condition (-not $rectangle.IsEmpty -and -not $Control.Current.IsOffscreen) 'The native pointer target must be visible.'
        $visible=$rectangle
        $visible.Intersect($window.Current.BoundingRectangle)
        if ($Control.Current.AutomationId.StartsWith('Text_')) { $visible.Intersect((Require-Control 'PaperScroll').Current.BoundingRectangle) }
        Assert-Condition (-not $visible.IsEmpty) 'The native pointer target must intersect the visible test editor.'
        [void][ClipboardAcceptanceInput]::SetCursorPos([int]($visible.X+$visible.Width/2),[int]($visible.Y+$visible.Height/2))
        [ClipboardAcceptanceInput]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
        [ClipboardAcceptanceInput]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
    }
    Start-Sleep -Milliseconds 200
}
function Click-Control([string]$Id) { Click-Element (Require-Control $Id) }
function Focus-Editor([string]$Id) { Foreground-App;(Require-Control $Id).SetFocus();Start-Sleep -Milliseconds 150 }
function Keyboard([string]$Keys) { Foreground-App;[Windows.Forms.SendKeys]::SendWait($Keys);Start-Sleep -Milliseconds 200 }
function Shift-Click([string]$Id) {
    Foreground-App
    [ClipboardAcceptanceInput]::keybd_event(16,0,0,[UIntPtr]::Zero)
    try { Click-Element (Require-Control $Id) $true } finally { [ClipboardAcceptanceInput]::keybd_event(16,0,2,[UIntPtr]::Zero) }
}
function Select-SidebarItem([int]$Index,[int]$Modifier=0) {
    $list=Require-Control 'BlockList'
    $condition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::ListItem)
    $items=$list.FindAll([Windows.Automation.TreeScope]::Descendants,$condition)
    Assert-Condition ($items.Count -gt $Index) 'The sidebar block item must be realized.'
    $item=$items.Item($Index)
    $scroll=$null
    if ($item.TryGetCurrentPattern([Windows.Automation.ScrollItemPattern]::Pattern,[ref]$scroll)) { $scroll.ScrollIntoView() }
    Foreground-App
    if ($Modifier) { [ClipboardAcceptanceInput]::keybd_event([byte]$Modifier,0,0,[UIntPtr]::Zero) }
    try { Click-Element $item $true } finally { if ($Modifier) { [ClipboardAcceptanceInput]::keybd_event([byte]$Modifier,0,2,[UIntPtr]::Zero) } }
}
function Sidebar-SelectionCount {
    return (Require-Control 'BlockList').GetCurrentPattern([Windows.Automation.SelectionPattern]::Pattern).Current.GetSelection().Count
}
function Choose-Section([string]$Id,[string]$Title) {
    if ((Read-Diagnostics).sectionId -eq $Id) { return }
    $search=Require-Control 'ChapterSearch'
    $search.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($Title)
    $item=Wait-For {
        $candidate=Find-Control ('Section_'+$Id)
        for ($depth=0;$candidate -and $depth -lt 8;$depth++) {
            if ($candidate.Current.ControlType -eq [Windows.Automation.ControlType]::TreeItem) { return $candidate }
            $candidate=[Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($candidate)
        }
        return $null
    } 'chapter tree item'
    Click-Element $item
    [void](Wait-For { $d=Read-Diagnostics;$d -and $d.sectionId -eq $Id } 'chapter selection')
    [void](Require-Control 'SaveButton')
}
function Save-Document {
    Click-Control 'SaveButton'
    [void](Wait-For { $d=Read-Diagnostics;$d -and -not $d.dirty } 'native save')
}
function Wait-EditorBlockCount([int]$Expected) {
    [void](Wait-For {
        $current=Read-Diagnostics
        if ($current -and $current.notice) { throw ('Clipboard action reported: '+$current.notice) }
        return $current -and @($current.blockIds).Count -eq $Expected
    } ('clipboard insertion of '+$Expected+' visible blocks'))
}
function Start-Native {
    if (Test-Path -LiteralPath $DiagnosticsPath) { Remove-Item -LiteralPath $DiagnosticsPath -Force }
    $startInfo=New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName=$ExecutablePath
    $startInfo.WorkingDirectory=[IO.Path]::GetDirectoryName($ExecutablePath)
    $startInfo.UseShellExecute=$false
    $startInfo.Arguments='--workspace "'+$BackendRoot+'" --runtime "'+$RuntimeDirectory+'" --port '+$Port+' --project "'+$ProjectDirectory+'" --diagnostics "'+$DiagnosticsPath+'"'
    $script:application=[Diagnostics.Process]::Start($startInfo)
    $startedApplicationIds.Add($application.Id)
    [void](Wait-For { $application.Refresh();$application.MainWindowHandle -ne [IntPtr]::Zero } 'real WinUI window' 40)
    $script:window=[Windows.Automation.AutomationElement]::FromHandle($application.MainWindowHandle)
    $window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern).SetWindowVisualState([Windows.Automation.WindowVisualState]::Maximized)
    [void](Wait-For { $d=Read-Diagnostics;$d -and $d.sectionId } 'editor initialization' 40)
    Assert-Condition ([IO.Path]::GetFullPath((Read-Diagnostics).projectPath) -eq $ProjectDirectory) 'The test must only edit its own generated project.'
    $script:servicePid=(Read-Json (Join-Path $RuntimeDirectory 'connection.json')).pid
}
function Stop-Native {
    if ($application -and -not $application.HasExited) {
        [void]$application.CloseMainWindow()
        if (-not $application.WaitForExit(5000)) { $application.Kill();[void]$application.WaitForExit(5000) }
    }
    $script:application=$null
    $script:window=$null
}

function Pointer-Cell([string]$Id, [bool]$Double=$false) {
    Foreground-App
    $control=Require-Control ('Cell_'+$Id)
    $rectangle=$control.Current.BoundingRectangle
    $rectangle.Intersect((Require-Control 'PaperScroll').Current.BoundingRectangle)
    Assert-Condition (-not $rectangle.IsEmpty -and -not $control.Current.IsOffscreen) 'The test cell must be visible.'
    [void][ClipboardAcceptanceInput]::SetCursorPos([int]($rectangle.X+$rectangle.Width/2),[int]($rectangle.Y+$rectangle.Height/2))
    [ClipboardAcceptanceInput]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
    [ClipboardAcceptanceInput]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
    if ($Double) {
        Start-Sleep -Milliseconds 70
        [ClipboardAcceptanceInput]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
        [ClipboardAcceptanceInput]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
    }
    Start-Sleep -Milliseconds 650
}
function Test-SelectionInteractions {
    $sourceBefore=Read-Section $seed.sourceId
    foreach ($item in $sourceBefore.blocks) { [void](Require-Control ('BlockSelector_'+$item.id)) }
    $headingId=$sourceBefore.blocks[0].id
    Click-Element (Require-Control ('BlockSelector_'+$headingId)) $true
    Assert-Condition (@((Read-Diagnostics).selectedBlockIds).Count -eq 1 -and (Read-Diagnostics).selectedBlockIds[0] -eq $headingId) 'Clicking a heading selector must select its whole block.'
    Click-Element (Require-Control ('BlockSelector_'+$headingId)) $true
    Assert-Condition (@((Read-Diagnostics).selectedBlockIds).Count -eq 0 -and -not (Read-Diagnostics).selectedBlockId) 'Clicking the last selected block again must cancel selection.'
    Click-Element (Require-Control ('BlockSelector_'+$seed.richId)) $true
    Click-Element (Require-Control ('BlockSelector_'+$seed.tableId)) $true
    $selected=@((Read-Diagnostics).selectedBlockIds)
    Assert-Condition ($selected.Count -eq 2 -and $selected[0] -eq $seed.richId -and $selected[1] -eq $seed.tableId) 'Plain clicks must accumulate nonadjacent paragraph and table blocks in document order.'
    Assert-Condition ((Sidebar-SelectionCount) -eq 2) 'Block buttons and the sidebar must show the same multi-selection.'
    Assert-Condition (-not (Read-Diagnostics).dirty -and (Json (Read-Section $seed.sourceId)) -eq (Json $sourceBefore)) 'Selecting blocks must leave document content unchanged.'
    Keyboard '^c'
    $copied=[Windows.Forms.Clipboard]::GetText()
    Assert-Condition ($copied.Contains($seed.richPlain) -and $copied.Contains('合并标题') -and -not $copied.Contains('来源的第二个段落')) 'Keyboard copy must include exactly the selected paragraph and whole table.'
    Click-Element (Require-Control ('BlockSelector_'+$seed.richId)) $true
    Assert-Condition (@((Read-Diagnostics).selectedBlockIds).Count -eq 1 -and (Read-Diagnostics).selectedBlockIds[0] -eq $seed.tableId) 'Deselecting one block must preserve the other selected block.'
    Click-Element (Require-Control ('BlockSelector_'+$seed.richId)) $true
    Keyboard '{DELETE}'
    Wait-EditorBlockCount ($sourceBefore.blocks.Count-2)
    Keyboard '^z'
    Wait-EditorBlockCount $sourceBefore.blocks.Count
    Save-Document
    Assert-Condition ((Json (Read-Section $seed.sourceId).blocks) -eq (Json $sourceBefore.blocks)) 'Delete and Undo must restore the selected blocks, table spans, marks and IDs exactly.'
    Passed 'Heading paragraph and table selectors toggle, accumulate, copy, delete and undo whole blocks' @{selectedIds=$selected;sidebarSynchronized=$true}

    $table=$sourceBefore.blocks | Where-Object id -eq $seed.tableId
    $firstCell=$table.node.content[1].content[0].attrs.id
    $secondCell=$table.node.content[1].content[1].attrs.id
    Pointer-Cell $firstCell
    Assert-Condition (@((Read-Diagnostics).selectedCells).Count -eq 1 -and (Read-Diagnostics).selectedCells[0] -eq $firstCell -and -not (Read-Diagnostics).editingCellId) 'Single clicking a small table cell must only select it.'
    Keyboard 'Unwanted'
    Save-Document
    Assert-Condition ((Json (Block $seed.tableId).node) -eq (Json $table.node)) 'Typing after a single click must not alter the cell.'
    Pointer-Cell $firstCell $true
    Assert-Condition ((Read-Diagnostics).editingCellId -eq $firstCell) 'Double clicking a small table cell must enter editing.'
    Keyboard '^{HOME}^+{END}'
    [ClipboardAcceptanceInput]::TypeText('EditedA1')
    Pointer-Cell $secondCell
    Assert-Condition (-not (Read-Diagnostics).editingCellId -and (Read-Diagnostics).selectedCells[0] -eq $secondCell) 'Clicking another cell must end editing and select the new cell.'
    Save-Document
    $edited=Block $seed.tableId
    Assert-Condition ((Plain-Node $edited.node.content[1].content[0]) -eq 'EditedA1' -and (Plain-Node $edited.node.content[1].content[1]) -eq 'A2') 'Only the double-clicked cell may change.'
    Keyboard '^z'
    Save-Document
    Assert-Condition ((Json (Block $seed.tableId).node) -eq (Json $table.node)) 'Undo must restore the exact table after cell editing.'
    Pointer-Cell $firstCell
    Shift-Click ('Cell_'+$secondCell)
    Assert-Condition (@((Read-Diagnostics).selectedCells).Count -eq 2 -and -not (Read-Diagnostics).editingCellId) 'Shift clicking must select a cell range without editing.'
    Pointer-Cell $firstCell
    Keyboard '{F2}'
    Assert-Condition ((Read-Diagnostics).editingCellId -eq $firstCell) 'F2 must edit the selected cell.'
    Keyboard '{ESC}'
    Assert-Condition (-not (Read-Diagnostics).editingCellId) 'Escape must end cell editing.'
    Passed 'Small table single click selects, double click edits, Shift selects a range and switching cells ends editing' @{cellIds=@($firstCell,$secondCell);contentRestored=$true}

    Choose-Section $seed.largeTableSectionId '3 大表格交互'
    $large=(Read-Section $seed.largeTableSectionId).blocks | Where-Object id -eq $seed.largeTableId
    $largeCell=$large.node.content[0].content[0].attrs.id
    $largeNext=$large.node.content[0].content[1].attrs.id
    $baselineEditors=(Read-Diagnostics).activeTextEditorCount
    Pointer-Cell $largeCell
    Assert-Condition (-not (Read-Diagnostics).editingCellId -and (Read-Diagnostics).activeTextEditorCount -eq $baselineEditors) 'Single clicking a large table must not mount a text editor.'
    Pointer-Cell $largeCell $true
    Assert-Condition ((Read-Diagnostics).editingCellId -eq $largeCell -and (Read-Diagnostics).activeTextEditorCount -eq ($baselineEditors+1)) 'Double clicking a large table must mount only the active cell editor.'
    Keyboard '^{HOME}^+{END}'
    [ClipboardAcceptanceInput]::TypeText('EditedLarge')
    Pointer-Cell $largeNext
    Assert-Condition (-not (Read-Diagnostics).editingCellId) 'Single clicking another large-table cell must only select it.'
    Pointer-Cell $largeNext $true
    Assert-Condition ((Read-Diagnostics).editingCellId -eq $largeNext -and (Read-Diagnostics).activeTextEditorCount -eq ($baselineEditors+1)) 'Only one large-table cell editor may remain mounted.'
    Keyboard '{TAB}'
    Assert-Condition ((Read-Diagnostics).editingCellId -eq $large.node.content[0].content[2].attrs.id) 'Tab must move editing to the next cell.'
    Click-Element (Require-Control ('BlockSelector_'+$seed.largeTableId)) $true
    Assert-Condition (-not (Read-Diagnostics).editingCellId -and @((Read-Diagnostics).selectedCells).Count -eq 0 -and (Read-Diagnostics).selectedBlockIds[0] -eq $seed.largeTableId) 'Selecting a table block must end cell editing and clear the cell selection.'
    Save-Document
    $savedLarge=Block $seed.largeTableId
    Assert-Condition ((Plain-Node $savedLarge.node.content[0].content[0]) -eq 'EditedLarge' -and (Plain-Node $savedLarge.node.content[0].content[1]) -eq 'R1C2') 'Large-table editing must save only the edited cell.'
    Passed 'Large tables preserve lazy editing, Tab navigation and whole-table selection' @{tableCells=110;mountedCellEditors=1}
}

try {
    Start-Native
    Assert-Condition ((Require-Control 'SaveButton').Current.FrameworkId -eq 'XAML') 'A real WinUI XAML window is required.'
    Choose-Section $seed.sourceId $seed.sourceTitle
    if ($SelectionInteractions) { Test-SelectionInteractions; return }
    $sourceBefore=Read-Section $seed.sourceId
    $targetBefore=Read-Section $seed.targetId
    $originalRich=Block $seed.richId
    $originalAnchor=Block $seed.targetAnchorId
    Focus-Editor ('Text_'+$seed.richId)
    Keyboard '^{HOME}'
    Click-Control 'CopyBlockButton'
    [void](Wait-For { [Windows.Forms.Clipboard]::GetText() -eq $seed.richPlain } 'single block clipboard text')
    Assert-Condition ((Json (Read-Section $seed.sourceId)) -eq (Json $sourceBefore)) 'Copy must not create a block or change persisted source content.'
    Assert-Condition (@((Read-Diagnostics).blockIds).Count -eq $sourceBefore.blocks.Count -and -not (Read-Diagnostics).dirty) 'Copy must leave the current editor unchanged.'
    Passed 'Copy single block writes clipboard without inserting content' @{blockId=$seed.richId;blockCount=$sourceBefore.blocks.Count;plainText=[Windows.Forms.Clipboard]::GetText()}

    $copyOriginPid=$application.Id
    Stop-Native
    Start-Native
    Assert-Condition ([Windows.Forms.Clipboard]::GetText() -eq $seed.richPlain) 'Clipboard.Flush must preserve clipboard text after the source app process exits.'

    Choose-Section $seed.targetId $seed.targetTitle
    Focus-Editor ('Text_'+$seed.targetAnchorId)
    Keyboard '^{HOME}{RIGHT 3}+{RIGHT 2}'
    Click-Control 'PasteBlockButton'
    Wait-EditorBlockCount ($targetBefore.blocks.Count+1)
    Save-Document
    $target=Read-Section $seed.targetId
    Assert-Condition ($target.blocks.Count -eq $targetBefore.blocks.Count+1) 'Single-block paste must insert exactly one block.'
    $copy=$target.blocks[2]
    Assert-Condition ($target.blocks[1].id -eq $seed.targetAnchorId -and $target.blocks[3].id -eq $seed.targetTailId) 'Paste must be immediately after the selected root.'
    Assert-Condition ((Json (Block $seed.targetAnchorId).content) -eq (Json $originalAnchor.content)) 'Paste must preserve the whole selected target paragraph, including selected text.'
    Assert-FreshCopy $originalRich $copy
    $singleCopyId=$copy.id
    Passed 'Flushed clipboard survives source app exit and pastes rich block after target with new IDs' @{source=$seed.richId;copy=$singleCopyId;anchor=$seed.targetAnchorId;sourceProcess=$copyOriginPid;pasteProcess=$application.Id}

    Click-Control 'Ribbon_Undo'
    Save-Document
    Assert-Condition (((Read-Section $seed.targetId).blocks.id -join ',') -eq ($targetBefore.blocks.id -join ',')) 'Undo must restore original target block order.'
    Click-Control 'Ribbon_Redo'
    Save-Document
    Assert-Condition (((Read-Section $seed.targetId).blocks.id -join ',') -eq ($target.blocks.id -join ',')) 'Redo must restore the pasted block with its saved identity.'
    Passed 'Paste Undo and Redo retain target content and pasted identity' @{copy=$singleCopyId}

    Choose-Section $seed.sourceId $seed.sourceTitle
    Select-SidebarItem 1
    Select-SidebarItem 3 17
    Assert-Condition ((Sidebar-SelectionCount) -eq 2) 'Ctrl clicking the sidebar must select two noncontiguous blocks.'
    Keyboard '^c'
    [void](Wait-For { $value=[Windows.Forms.Clipboard]::GetText();$value.Contains($seed.richPlain) -and $value.Contains('A1') -and -not $value.Contains((Plain-Node $sourceBefore.blocks[2].node)) } 'sidebar Ctrl multi-block clipboard text')
    Select-SidebarItem 1
    Select-SidebarItem 4 16
    Assert-Condition ((Sidebar-SelectionCount) -eq 4) 'Shift clicking the sidebar must select the whole four-block range.'
    Keyboard '^c'
    [void](Wait-For { $value=[Windows.Forms.Clipboard]::GetText();$value.Contains($seed.richPlain) -and $value.Contains('A1') -and $value.Contains('A2') -and $value.Contains((Plain-Node $sourceBefore.blocks[4].node)) } 'multi-block clipboard text')
    Assert-Condition ((Json (Read-Section $seed.sourceId)) -eq (Json $sourceBefore)) 'Multi-block copy must leave all source blocks unchanged.'
    Choose-Section $seed.targetId $seed.targetTitle
    Select-SidebarItem 1
    Select-SidebarItem 3 17
    Assert-Condition ((Sidebar-SelectionCount) -eq 2) 'The target chapter must retain a two-block selection before paste.'
    [void](Wait-For { (Read-Diagnostics).selectedBlockId -eq $seed.targetTailId } 'last selected target root')
    Keyboard '^v'
    Wait-EditorBlockCount 8
    Save-Document
    $target=Read-Section $seed.targetId
    $sourceCopies=@($target.blocks | Select-Object -Skip 4)
    Assert-Condition ($sourceCopies.Count -eq 4) 'Range copy must paste all four blocks once, in document order.'
    Assert-Condition (($target.blocks[0..3].id -join ',') -eq (@($targetBefore.blocks[0].id,$seed.targetAnchorId,$singleCopyId,$seed.targetTailId) -join ',')) 'Pasting with multiple target blocks selected must preserve the target blocks and insert after the last clicked root.'
    for ($index=0;$index -lt 4;$index++) { Assert-FreshCopy $sourceBefore.blocks[$index+1] $sourceCopies[$index] }
    Passed 'Sidebar Ctrl and Shift selections with Ctrl+C preserve order rich marks and merged table' @{copies=@($sourceCopies.id);tableCopy=$sourceCopies[2].id}

    Choose-Section $seed.sourceId $seed.sourceTitle
    Focus-Editor ('Text_'+$seed.richId)
    Keyboard '^{HOME}+{RIGHT 2}^c'
    [void](Wait-For { [Windows.Forms.Clipboard]::GetText() -eq 'H2' } 'ordinary text selection clipboard')
    Assert-Condition ((Json (Read-Section $seed.sourceId)) -eq (Json $sourceBefore)) 'Ordinary text copying must not mutate blocks.'
    Passed 'Ctrl+C preserves ordinary selected-text copying' @{plainText=[Windows.Forms.Clipboard]::GetText()}

    Choose-Section $seed.targetId $seed.targetTitle
    $beforeSelectedText=Read-Section $seed.targetId
    $originalAnchorText=Plain-Node $originalAnchor.node
    Focus-Editor ('Text_'+$seed.targetAnchorId)
    Keyboard '^{HOME}{RIGHT 3}+{RIGHT 2}^v'
    $expectedSelectedText=$originalAnchorText.Substring(0,3)+'H2'+$originalAnchorText.Substring(5)
    [void](Wait-For { (Plain-Node (Block $seed.targetAnchorId).node) -eq $expectedSelectedText } 'selected text pasted inside existing root')
    Save-Document
    $afterSelectedText=Read-Section $seed.targetId
    Assert-Condition (($afterSelectedText.blocks.id -join ',') -eq ($beforeSelectedText.blocks.id -join ',')) 'Selected-text paste into nonempty content must keep every block identity and order.'
    Passed 'Text copied from another block replaces selected text without creating a block' @{anchor=$seed.targetAnchorId;text=$expectedSelectedText;blockCount=$afterSelectedText.blocks.Count}
    Click-Control 'Ribbon_Undo'
    Save-Document
    Assert-Condition ((Json (Block $seed.targetAnchorId).content) -eq (Json $originalAnchor.content)) 'Undo restores exact original target text and formatting.'

    $beforeExternal=Read-Section $seed.targetId
    Focus-Editor ('Text_'+$seed.targetAnchorId)
    Keyboard '^{HOME}{RIGHT 3}+{RIGHT 2}'
    $externalText="外部第一段。`r`n`r`n  `r`n外部第二段。`n`n外部第三段。"
    [Windows.Forms.Clipboard]::SetText($externalText)
    $keyboardFocus=[Windows.Automation.AutomationElement]::FocusedElement.Current
    Assert-Condition ($keyboardFocus.ProcessId -eq $application.Id -and $keyboardFocus.HasKeyboardFocus -and $keyboardFocus.AutomationId -eq ('Text_'+$seed.targetAnchorId)) 'External paste must start in the target paragraph owned by the test process.'
    @{focusedControl=$keyboardFocus.AutomationId;focusedName=$keyboardFocus.Name;focusedProcessId=$keyboardFocus.ProcessId;focusedType=$keyboardFocus.ControlType.ProgrammaticName;hasKeyboardFocus=$keyboardFocus.HasKeyboardFocus;clipboardText=[Windows.Forms.Clipboard]::GetText();clipboardFormats=@([Windows.Forms.Clipboard]::GetDataObject().GetFormats());diagnostics=Read-Diagnostics} | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath (Join-Path $RunDirectory 'before-external-paste.json') -Encoding UTF8
    Keyboard '^v'
    $expectedInline=$originalAnchorText.Substring(0,3)+$externalText.Replace("`r`n","`n").Replace("`r","`n")+$originalAnchorText.Substring(5)
    [void](Wait-For { (Inline-Text (Block $seed.targetAnchorId).node) -eq $expectedInline } 'multiline text inserted inside existing root')
    Save-Document
    $afterExternal=Read-Section $seed.targetId
    Assert-Condition (($afterExternal.blocks.id -join ',') -eq ($beforeExternal.blocks.id -join ',')) 'Multiline paste into a nonempty target must not create or reorder blocks.'
    Assert-Condition ((Inline-Text (Block $seed.targetAnchorId).node) -eq $expectedInline) 'Inline paste replaces only selected text and preserves text before and after the selection, including pasted newlines.'
    foreach ($oldBlock in $beforeExternal.blocks | Where-Object id -ne $seed.targetAnchorId) {
        Assert-Condition ((Json (Block $oldBlock.id).node) -eq (Json $oldBlock.node)) 'Inline paste must not alter any neighboring block.'
    }
    Passed 'Multiline external Ctrl+V stays in the nonempty target and replaces only selected text' @{anchor=$seed.targetAnchorId;blockCount=$afterExternal.blocks.Count;text=Inline-Text (Block $seed.targetAnchorId).node}

    Click-Control 'Ribbon_Undo'
    Save-Document
    Assert-Condition ((Semantic-Blocks (Read-Section $seed.targetId).blocks) -eq (Semantic-Blocks $beforeExternal.blocks)) 'Inline paste Undo must restore all block contents as one operation.'
    Click-Control 'Ribbon_Redo'
    Save-Document
    Assert-Condition ((Semantic-Blocks (Read-Section $seed.targetId).blocks) -eq (Semantic-Blocks $afterExternal.blocks)) 'Inline paste Redo must restore the exact pasted text and block identities.'

    Focus-Editor ('Text_'+$seed.targetAnchorId)
    Keyboard '^{END}'
    [Windows.Forms.Clipboard]::SetText('末尾粘贴')
    Click-Control 'PasteBlockButton'
    [void](Wait-For { (Inline-Text (Block $seed.targetAnchorId).node) -eq ($expectedInline+'末尾粘贴') } 'paste button inserts at the existing caret')
    Save-Document
    Assert-Condition ((Read-Section $seed.targetId).blocks.Count -eq $beforeExternal.blocks.Count) 'Plain-text paste button must use the same inline rule as Ctrl+V.'
    Click-Control 'Ribbon_Undo'
    Save-Document
    Assert-Condition ((Semantic-Blocks (Read-Section $seed.targetId).blocks) -eq (Semantic-Blocks $afterExternal.blocks)) 'Button paste can undo independently from previous multiline paste.'
    Passed 'Paste button inserts plain text at the caret with independent Undo' @{anchor=$seed.targetAnchorId;blockCount=$beforeExternal.blocks.Count}

    Select-SidebarItem 1
    Click-Control 'InsertBlockButton'
    Wait-EditorBlockCount ($afterExternal.blocks.Count+1)
    Save-Document
    $beforeEmpty=Read-Section $seed.targetId
    $emptyId=(Read-Diagnostics).selectedBlockId
    Assert-Condition ((Plain-Node (Block $emptyId).node) -eq '') 'The paragraph inserted for the empty-block test must be blank.'
    Focus-Editor ('Text_'+$emptyId)
    [Windows.Forms.Clipboard]::SetText($externalText)
    Keyboard '^v'
    Wait-EditorBlockCount ($beforeEmpty.blocks.Count+2)
    Save-Document
    $afterEmpty=Read-Section $seed.targetId
    $emptyIndex=[Array]::IndexOf(@($beforeEmpty.blocks.id),$emptyId)
    $paragraphCopies=@($afterEmpty.blocks | Select-Object -Skip $emptyIndex -First 3)
    $expectedText=@('外部第一段。','外部第二段。','外部第三段。')
    Assert-Condition ($paragraphCopies[0].id -eq $emptyId) 'The first pasted paragraph must reuse the blank root identity.'
    for ($index=0;$index -lt 3;$index++) {
        Assert-Condition ($paragraphCopies[$index].type -eq 'paragraph' -and (Plain-Node $paragraphCopies[$index].node) -eq $expectedText[$index]) 'Blank target splits nonempty paragraphs in order and ignores blank lines.'
        if ($index -gt 0) { Assert-Condition ($beforeEmpty.blocks.id -notcontains $paragraphCopies[$index].id) 'Continuation paragraphs must have fresh IDs.' }
    }
    foreach ($oldBlock in $beforeEmpty.blocks | Where-Object id -ne $emptyId) {
        Assert-Condition ((Json (Block $oldBlock.id).node) -eq (Json $oldBlock.node)) 'Filling a blank paragraph leaves all existing nonempty blocks intact.'
    }
    Click-Control 'Ribbon_Undo'
    Save-Document
    Assert-Condition ((Semantic-Blocks (Read-Section $seed.targetId).blocks) -eq (Semantic-Blocks $beforeEmpty.blocks)) 'Undo restores the original empty root and removes all continuation paragraphs.'
    Click-Control 'Ribbon_Redo'
    Save-Document
    Assert-Condition ((Semantic-Blocks (Read-Section $seed.targetId).blocks) -eq (Semantic-Blocks $afterEmpty.blocks)) 'Redo restores all split paragraphs and their saved IDs.'
    Passed 'Blank text block receives first paragraph and splits only subsequent nonempty paragraphs with Undo Redo' @{blankId=$emptyId;paragraphIds=@($paragraphCopies.id);blockCount=$afterEmpty.blocks.Count}

    $expectedFinal=Read-Section $seed.targetId
    Stop-Native
    Start-Native
    Choose-Section $seed.targetId $seed.targetTitle
    $reopened=Read-Section $seed.targetId
    Assert-Condition ((Json $reopened.blocks) -eq (Json $expectedFinal.blocks)) 'Saving and reopening must recover all pasted identities, contents, formatting and order.'
    Assert-Condition ((Json (Read-Section $seed.sourceId)) -eq (Json $sourceBefore)) 'The original source chapter must remain unchanged after every clipboard operation.'
    $allIds=@($sourceBefore.blocks | ForEach-Object { Node-Ids $_.node })+@($reopened.blocks | ForEach-Object { Node-Ids $_.node })
    Assert-Condition (@($allIds | Select-Object -Unique).Count -eq $allIds.Count) 'Every source and pasted node identity must be globally unique.'
    Passed 'External paste Undo Redo save and reopen preserve every block and node identity' @{targetBlockCount=$reopened.blocks.Count;totalUniqueNodeCount=$allIds.Count}

    Select-SidebarItem 1
    Select-SidebarItem 1 17
    Assert-Condition ((Sidebar-SelectionCount) -eq 0) 'Ctrl clicking the only selected sidebar item must cancel block selection.'
    [void](Wait-For { $current=Read-Diagnostics;$current -and -not $current.selectedBlockId -and @($current.selectedBlockIds).Count -eq 0 } 'no selected root after sidebar deselection')
    [Windows.Forms.Clipboard]::SetText('没有选中内容块时追加到本节末尾。')
    Keyboard '^v'
    Wait-EditorBlockCount ($reopened.blocks.Count+1)
    Save-Document
    $appended=Read-Section $seed.targetId
    Assert-Condition ((Json @($appended.blocks | Select-Object -First $reopened.blocks.Count)) -eq (Json $reopened.blocks)) 'Paste without a selected root must preserve every existing block exactly.'
    Assert-Condition ($appended.blocks[-1].type -eq 'paragraph' -and (Plain-Node $appended.blocks[-1].node) -eq '没有选中内容块时追加到本节末尾。') 'Paste without a selected root must append a paragraph at chapter end.'
    Assert-Condition ($reopened.blocks.id -notcontains $appended.blocks[-1].id) 'Appended paragraph must have a new identity.'
    Passed 'Cancelling the last sidebar selection makes paste append to chapter end' @{appendId=$appended.blocks[-1].id;targetBlockCount=$appended.blocks.Count}
} catch {
    $failure=$_.Exception.ToString()
    if ($window) {
        try {
            @($window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition) | ForEach-Object {
                @{id=$_.Current.AutomationId;name=$_.Current.Name;type=$_.Current.ControlType.ProgrammaticName;offscreen=$_.Current.IsOffscreen}
            }) | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $RunDirectory 'uia-debug.json') -Encoding UTF8
        } catch {}
    }
    Write-Error $failure -ErrorAction Continue
} finally {
    Stop-Native
    if ($servicePid) {
        $ownedService=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$servicePid) -ErrorAction SilentlyContinue
        if ($ownedService -and $startedApplicationIds.Contains([int]$ownedService.ParentProcessId) -and $ownedService.Name -eq 'node.exe' -and $ownedService.CommandLine -and $ownedService.CommandLine.Contains($BackendRoot)) { Stop-Process -Id $servicePid -ErrorAction SilentlyContinue }
    }
    try { if ($originalClipboard) { [Windows.Forms.Clipboard]::SetDataObject($originalClipboard,$true) } else { [Windows.Forms.Clipboard]::Clear() } } catch {}
    Save-Results
}
if ($failure) { exit 1 }
