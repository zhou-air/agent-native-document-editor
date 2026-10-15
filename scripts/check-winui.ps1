[CmdletBinding()]
param(
    [string]$ExecutablePath,
    [switch]$SkipCore,
    [string]$TestRoot = 'C:\Dev\agentdoc-winui-tests',
    [string]$ResumeRunDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $ExecutablePath) { $ExecutablePath = Join-Path $projectRoot 'release/AgentDocument-WinUI-x64/AgentDocument.WinUI.exe' }
$ExecutablePath = [IO.Path]::GetFullPath($ExecutablePath)
$backendRoot = Join-Path ([IO.Path]::GetDirectoryName($ExecutablePath)) 'backend'
$nodePath = Join-Path $backendRoot 'node.exe'
if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) { throw "Publish the native application first: $ExecutablePath" }
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw 'The release is missing its bundled backend Node runtime.' }
$runDirectory = Join-Path ([IO.Path]::GetFullPath($TestRoot)) ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
if ($ResumeRunDirectory) {
    $runDirectory = [IO.Path]::GetFullPath($ResumeRunDirectory)
    if (-not $runDirectory.StartsWith(([IO.Path]::GetFullPath($TestRoot).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Resume run must lie inside the controlled WinUI test root.' }
}
$runtimeDirectory = Join-Path $runDirectory 'runtime'
$projectDirectory = Join-Path $runDirectory 'project'
$diagnosticsPath = Join-Path $runDirectory 'native-diagnostics.json'
$artifactDirectory = Join-Path $projectRoot 'artifacts/winui'
New-Item -ItemType Directory -Path $runDirectory, $artifactDirectory -Force | Out-Null
$checks = [Collections.Generic.List[object]]::new()
try {
    foreach ($name in @('coreclr.dll', 'hostfxr.dll', 'hostpolicy.dll', 'Microsoft.UI.Xaml.dll', 'Microsoft.WindowsAppRuntime.dll', 'WinRT.Runtime.dll')) {
        if (-not (Test-Path -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($ExecutablePath)) $name) -PathType Leaf)) { throw "The self-contained release is missing: $name" }
    }
    $runtimeConfig = Get-Content -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($ExecutablePath)) 'AgentDocument.WinUI.runtimeconfig.json') -Raw | ConvertFrom-Json
    if (-not $runtimeConfig.runtimeOptions.PSObject.Properties['includedFrameworks']) { throw 'Published .NET application is framework-dependent.' }
    if (Test-Path -LiteralPath (Join-Path $backendRoot 'node_modules/electron/package.json')) { throw 'Electron must not be used as the native frontend backend runtime.' }
    $checks.Add([pscustomobject]@{ name = 'Self-contained native runtime and independent Node backend'; status = 'passed'; evidence = $ExecutablePath })
    if (-not $SkipCore) {
        Push-Location $projectRoot
        try { & $nodePath --test tests/store-v2.test.js tests/semantic-docx.test.js tests/service-v2.test.js tests/migration-content.test.js tests/store-review.test.js 2>&1 | Tee-Object -FilePath (Join-Path $artifactDirectory 'core-tests.txt'); $coreExitCode = $LASTEXITCODE }
        finally { Pop-Location }
        if ($coreExitCode -ne 0) { throw 'Existing backend core checks failed.' }
        $checks.Add([pscustomobject]@{ name = 'Existing document/atomic-store core checks'; status = 'passed'; evidence = 'core-tests.txt' })
    }
    $seedPath = Join-Path $runDirectory 'fixture-seed.json'
    if (-not $ResumeRunDirectory) {
        & $nodePath (Join-Path $projectRoot 'tests/winui/prepare-v2.mjs') $projectDirectory $seedPath
        if ($LASTEXITCODE -ne 0) { throw 'Isolated DOCX fixture preparation failed.' }
    }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $resumeArguments = @()
    if ($ResumeRunDirectory) { $resumeArguments = @('-ResumeAfterTables') }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $projectRoot 'tests/winui/incremental-v2.ps1') -ExecutablePath $ExecutablePath -BackendRoot $backendRoot -ProjectRoot $projectRoot -RuntimeDirectory $runtimeDirectory -ProjectDirectory $projectDirectory -DiagnosticsPath $diagnosticsPath -SeedPath $seedPath -RunDirectory $runDirectory -Port $port @resumeArguments
    $nativeExitCode = $LASTEXITCODE
    $nativeResultPath = Join-Path $runDirectory 'native-ui-results.json'
    if (Test-Path -LiteralPath $nativeResultPath) {
        $nativeResults = Get-Content -LiteralPath $nativeResultPath -Raw | ConvertFrom-Json
        foreach ($check in $nativeResults.checks) { $checks.Add($check) }
    }
    if ($nativeExitCode -ne 0) { throw "Native UI verification failed. Inspect the retained evidence: $runDirectory" }
    $success = $true
} catch {
    $checks.Add([pscustomobject]@{ name = 'Verification stopped'; status = 'failed'; evidence = $_.Exception.Message })
    $success = $false
    Write-Error $_ -ErrorAction Continue
} finally {
    $result = [ordered]@{
        createdAt = [DateTimeOffset]::Now.ToString('o')
        success = $success
        executable = $ExecutablePath
        runDirectory = $runDirectory
        visualReview = 'Not performed; personal-use deliverable, as requested.'
        checks = $checks
    }
    $result | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath (Join-Path $artifactDirectory 'winui-results.json') -Encoding utf8
}
if (-not $success) { exit 1 }
Write-Host "Native functionality verified; evidence: $runDirectory"
