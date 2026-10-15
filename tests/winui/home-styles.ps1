[CmdletBinding()]
param([string]$ExecutablePath, [string]$TestRoot = 'C:/Dev/agentdoc-home-tests')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not $ExecutablePath) { $ExecutablePath = Join-Path $ProjectRoot 'release/AgentDocument-WinUI-x64/AgentDocument.WinUI.exe' }
$RunDirectory = Join-Path $TestRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
$RuntimeDirectory = Join-Path $RunDirectory 'runtime'
$DiagnosticsPath = Join-Path $RunDirectory 'diagnostics.json'
$WorkspaceDirectory = Join-Path $RunDirectory 'workspace'
New-Item -ItemType Directory -Path $WorkspaceDirectory -Force | Out-Null
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $listener.Start(); $Port = $listener.LocalEndpoint.Port; $listener.Stop()
$application = $null; $window = $null
$checks = [Collections.Generic.List[string]]::new()
$failure = $null
# Reuse the existing guarded WinUI input helpers, parsed by named AST definitions.
$helperPath = Join-Path $PSScriptRoot 'incremental-v2.ps1'
$helperText = Get-Content -LiteralPath $helperPath -Raw -Encoding UTF8
$tokens = $null; $parseErrors = $null
$helperAst = [Management.Automation.Language.Parser]::ParseInput($helperText, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Cannot parse the existing native UI helpers.' }
$typesStart = $helperText.IndexOf('Add-Type -AssemblyName')
$typesEnd = $helperText.IndexOf('$nodePath =', $typesStart)
Invoke-Expression $helperText.Substring($typesStart, $typesEnd - $typesStart)
$helperNames = @('Assert-Condition','Wait-For','Read-Diagnostics','Read-UnlockedJson','Find-Control','Require-Control','Is-OwnedWindow','Foreground-App','Click-Element','Click-Control','Keyboard','Focus-Editor','Focus-EditableControl','Select-ComboItem','Fill-OwnedFilePicker')
foreach ($definition in $helperAst.FindAll({param($ast) $ast -is [Management.Automation.Language.FunctionDefinitionAst]}, $false)) {
    if ($definition.Name -in $helperNames) { Invoke-Expression $definition.Extent.Text }
}
function Click-Element($Control, [string]$Description) {
    Foreground-App
    $pattern = $null
    if ($Control.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke() }
    elseif ($Control.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) { $pattern.Select() }
    else {
        $bounds = $Control.Current.BoundingRectangle
        Assert-Condition (-not $bounds.IsEmpty -and -not $Control.Current.IsOffscreen) ('Control is not visible: ' + $Description)
        try { $point = $Control.GetClickablePoint() } catch { $point = [Windows.Point]::new($bounds.X+$bounds.Width/2, $bounds.Y+$bounds.Height/2) }
        [void][NativeAcceptanceInput]::SetCursorPos([int]$point.X, [int]$point.Y)
        [NativeAcceptanceInput]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [NativeAcceptanceInput]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
    }
    Start-Sleep -Milliseconds 200
    return $Control
}
function Api([string]$Route, $Body = $null) {
    $c = Read-UnlockedJson (Join-Path $RuntimeDirectory 'connection.json')
    $headers = @{ Authorization = 'Bearer ' + $c.token }
    if ($null -eq $Body) { return Invoke-RestMethod -Uri ($c.url + $Route) -Headers $headers }
    $json = $Body | ConvertTo-Json -Depth 90 -Compress
    return Invoke-RestMethod -Uri ($c.url + $Route) -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json))
}
function Tool([string]$Name, $Arguments) { return Api '/api/tool' @{ name = $Name; args = $Arguments } }
function Start-App {
    if (Test-Path -LiteralPath $DiagnosticsPath) { Remove-Item -LiteralPath $DiagnosticsPath }
    $argsText = '--workspace "' + $WorkspaceDirectory + '" --runtime "' + $RuntimeDirectory + '" --port ' + $Port + ' --diagnostics "' + $DiagnosticsPath + '"'
    $script:application = Start-Process -FilePath $ExecutablePath -ArgumentList $argsText -PassThru -WindowStyle Normal
    [void](Wait-For { $application.Refresh(); $application.MainWindowHandle -ne [IntPtr]::Zero } 'native home window' 40)
    $script:window = [Windows.Automation.AutomationElement]::FromHandle($application.MainWindowHandle)
    $window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern).SetWindowVisualState([Windows.Automation.WindowVisualState]::Maximized)
    [void](Wait-For { (Read-Diagnostics).view -eq 'home' } 'default project homepage' 30)
}
function Stop-App {
    if ($application -and -not $application.HasExited) { [void]$application.CloseMainWindow(); if (-not $application.WaitForExit(6000)) { throw 'Test window did not close after saving.' } }
    $script:window = $null
}
function Passed([string]$Name) { $checks.Add($Name); Write-Host ('PASS ' + $Name) }
function Number-Field([string]$Id, [string]$Value) {
    [void](Focus-EditableControl $Id); Keyboard '^a'; Keyboard $Value; Keyboard '{TAB}'
}
function Current-Paragraph {
    $p = (Api '/api/project').project
    $s = Tool 'read_section' @{ section_id = $p.sections[0].id; project_id = $p.id }
    return @($s.blocks | Where-Object { $_.type -eq 'paragraph' })[0]
}
function Import-Fixture {
    [void](Click-Control 'ImportButton'); Fill-OwnedFilePicker (Join-Path $ProjectRoot 'tests/fixtures/engineering.docx')
    [void](Wait-For { $d = Read-Diagnostics; $d.view -eq 'editor' -and $d.projectTitle -eq 'engineering' } 'single-picker automatic DOCX import' 30)
    return Read-Diagnostics
}
try {
    Start-App
    Assert-Condition ((Read-Diagnostics).projectListCount -eq 0) 'Fresh isolated workspace should start empty'
    Passed 'Default launch opens the in-app project homepage'
    $first = Import-Fixture
    Assert-Condition ($first.projectPath.StartsWith((Join-Path $WorkspaceDirectory 'projects'), [StringComparison]::OrdinalIgnoreCase)) 'Import must use the application projects directory'
    $application.Refresh(); Assert-Condition ($application.MainWindowTitle -eq 'engineering — 文档工作台') 'Project name must appear in the native window title'
    Passed 'DOCX selection creates and opens a named local project without a second dialog'
    $body = Current-Paragraph
    $body.node.content = @(@{type='text';text='重点';marks=@(@{type='bold'})},@{type='text';text='，用于格式检查的正文。'})
    $updated = Tool 'update_block' @{block_id=$body.id;expected_revision=$body.revision;node=$body.node}
    [void](Wait-For { (Read-Diagnostics).projectRevision -ge $updated.revision } 'isolated rich-text paragraph fixture loaded')
    $body = Current-Paragraph
    $before = $body.node | ConvertTo-Json -Depth 90 -Compress
    [void](Click-Control 'LayoutTab')
    (Require-Control 'StyleFont').GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue('仿宋')
    Number-Field 'StyleSize' '15'; Number-Field 'StyleBefore' '8'; Number-Field 'StyleAfter' '10'; Number-Field 'StyleIndent' '30'
    Select-ComboItem 'StyleAlignment' '两端对齐'
    foreach ($choice in @(@('单倍',240,1),@('1.5 倍',360,1.5),@('2 倍',480,2))) {
        Select-ComboItem 'StyleLine' $choice[0]; [void](Click-Control 'SaveStylesButton')
        [void](Wait-For { $d = Read-Diagnostics; -not $d.styleDirty -and @($d.formatting | Where-Object { $_.nodeId -eq $body.id -and $_.line -eq $choice[2] }).Count } 'native paragraph style persistence')
        $p = (Api '/api/project').project
        Assert-Condition ($p.styles.semantic.body.paragraph.line -eq $choice[1]) 'Only the three agreed line-spacing values should be stored'
    }
    $format = @((Read-Diagnostics).formatting | Where-Object { $_.nodeId -eq $body.id })[0]
    Assert-Condition ($format.size -eq 15 -and $format.alignment -eq 'Justify' -and $format.before -eq 8 -and $format.after -eq 10 -and $format.firstLine -eq 30) 'Native paragraph formatting must match saved document style'
    Assert-Condition (((Current-Paragraph).node | ConvertTo-Json -Depth 90 -Compress) -eq $before) 'Applying document styles must not change content or inline marks'
    Passed 'All three line spacings, font size, alignment, spacing and first-line indent reach the native editor'
    Select-ComboItem 'SemanticStyle' '标题 1'; Number-Field 'StyleSize' '22'; [void](Click-Control 'SaveStylesButton')
    [void](Wait-For { -not (Read-Diagnostics).styleDirty } 'heading style committed')
    Assert-Condition ((Api '/api/project').project.styles.semantic.body.font.sizePt -eq 15) 'Heading changes must not overwrite the body style'
    Passed 'Heading levels and body keep independent document styles'
    Select-ComboItem 'SemanticStyle' '正文'; [void](Click-Control 'StyleBold'); [void](Click-Control 'SaveStylesButton')
    [void](Wait-For { -not (Read-Diagnostics).styleDirty } 'inherited body bold committed')
    [void](Focus-Editor ('Text_' + $body.id)); Keyboard '^{END}'; Keyboard 'x'; [void](Click-Control 'SaveButton')
    [void](Wait-For { -not (Read-Diagnostics).dirty } 'typed body saved')
    $edited = Current-Paragraph
    Assert-Condition ($edited.node.content[-1].text.EndsWith('x')) 'Typed text must survive style refresh'
    $tailMarks = $edited.node.content[-1].PSObject.Properties['marks']
    Assert-Condition (-not $tailMarks -or -not @($tailMarks.Value | Where-Object { $_.type -eq 'bold' }).Count) 'Inherited bold must not become an inline mark'
    $selection = @((Read-Diagnostics).formatting | Where-Object { $_.nodeId -eq $body.id })[0]
    Number-Field 'StyleAfter' '12'; [void](Click-Control 'SaveStylesButton')
    [void](Wait-For { -not (Read-Diagnostics).styleDirty } 'style refresh after typed content')
    $refreshed = @((Read-Diagnostics).formatting | Where-Object { $_.nodeId -eq $body.id })[0]
    Assert-Condition ((Read-Diagnostics).canUndo -and $refreshed.selectionStart -eq $selection.selectionStart -and $refreshed.selectionEnd -eq $selection.selectionEnd) 'Style refresh must keep content undo and selection'
    [void](Click-Control 'HomeTab'); [void](Click-Control 'Ribbon_Undo'); [void](Click-Control 'SaveButton')
    [void](Wait-For { ((Current-Paragraph).node | ConvertTo-Json -Depth 90 -Compress) -eq $before } 'content undo after style refresh')
    Passed 'Style inheritance keeps inline semantics separate and preserves content undo'
    $p = (Api '/api/project').project
    $c = Read-UnlockedJson (Join-Path $RuntimeDirectory 'connection.json')
    $export = Join-Path $RunDirectory 'styled.docx'
    Invoke-WebRequest -Uri ($c.url + '/api/export') -Headers @{ Authorization = 'Bearer ' + $c.token } -Method Post -ContentType 'application/json' -Body (@{project_id=$p.id;format='docx'} | ConvertTo-Json -Compress) -OutFile $export -UseBasicParsing | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($export)
    try { $reader = [IO.StreamReader]::new($zip.GetEntry('word/styles.xml').Open()); try { [xml]$xml = $reader.ReadToEnd() } finally { $reader.Dispose() } } finally { $zip.Dispose() }
    $ns = [Xml.XmlNamespaceManager]::new($xml.NameTable); $ns.AddNamespace('w','http://schemas.openxmlformats.org/wordprocessingml/2006/main')
    $normal = $xml.SelectSingleNode('//w:style[@w:styleId="Normal"]', $ns)
    Assert-Condition ($normal.SelectSingleNode('w:rPr/w:sz', $ns).GetAttribute('val',$ns.LookupNamespace('w')) -eq '30') 'Word export must use the selected 15 pt body size'
    Assert-Condition ($normal.SelectSingleNode('w:pPr/w:spacing', $ns).GetAttribute('line',$ns.LookupNamespace('w')) -eq '480') 'Word export must use double line spacing'
    Assert-Condition ($normal.SelectSingleNode('w:pPr/w:ind', $ns).GetAttribute('firstLine',$ns.LookupNamespace('w')) -eq '600') 'Word export must use the selected 30 pt indent'
    Passed 'Exported DOCX and native editor share the stored paragraph settings'
    [void](Click-Control 'OpenProjectButton')
    [void](Wait-For { (Read-Diagnostics).view -eq 'home' -and (Read-Diagnostics).projectListCount -eq 1 } 'return to populated homepage')
    $second = Import-Fixture
    Assert-Condition ($second.projectPath -ne $first.projectPath) 'Repeated imports must use separate project directories'
    Assert-Condition ($second.projectId -ne $first.projectId) 'Repeated imports must have separate project identities and drafts'
    [void](Click-Control 'OpenProjectButton'); [void](Wait-For { (Read-Diagnostics).projectListCount -eq 2 } 'two imported projects in homepage')
    Stop-App; Start-App
    [void](Wait-For { (Read-Diagnostics).projectListCount -eq 2 } 'project history loaded after native restart')
    $list = Require-Control 'RecentProjects'
    $items = Wait-For { $visibleItems = $list.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::ListItem)); if ($visibleItems.Count -eq 2) { return ,$visibleItems } } 'two rendered native project rows'
    Assert-Condition ($items.Count -eq 2) 'Both projects must be clickable native list items'
    [void](Click-Element $items[1] 'recent project')
    [void](Wait-For { (Read-Diagnostics).view -eq 'editor' } 'open recent project inside app')
    Passed 'Repeated imports stay independent and recent projects remain clickable after restart'
} catch { $failure = $_.ToString(); throw } finally {
    try { Stop-App } catch { if (-not $failure) { $failure = $_.ToString() }; if ($application -and -not $application.HasExited) { $application.Kill() } }
    $connectionPath = Join-Path $RuntimeDirectory 'connection.json'
    if (Test-Path -LiteralPath $connectionPath) {
        $connection = Read-UnlockedJson $connectionPath
        $ownedListener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if ($ownedListener -and $ownedListener.OwningProcess -eq $connection.pid) { Stop-Process -Id $connection.pid -ErrorAction SilentlyContinue }
    }
    $result = @{ checks = $checks; error = $failure; runDirectory = $RunDirectory }
    $result | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath (Join-Path $RunDirectory 'home-styles-results.json') -Encoding UTF8
    Write-Host ('Evidence: ' + $RunDirectory)
}
