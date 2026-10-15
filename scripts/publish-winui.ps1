[CmdletBinding()]
param(
    [switch]$Zip,
    [switch]$KeepPrevious,
    [switch]$FrontendOnly,
    [string]$ReusePreparedPayload,
    [string]$BuildRoot = 'C:\Dev\agentdoc-winui-build',
    [string]$NodePath,
    [ValidateSet('Npm')][string]$BackendDependencies = 'Npm'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'release'))
$buildRootPath = [IO.Path]::GetFullPath($BuildRoot)
$releaseName = 'AgentDocument-WinUI-x64'
$releaseDirectory = Join-Path $releaseRoot $releaseName
$runName = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$runDirectory = Join-Path $buildRootPath $runName
$sourceDirectory = Join-Path $runDirectory 'native'
$stagingDirectory = Join-Path $runDirectory 'publish'
if ($ReusePreparedPayload) {
    $stagingDirectory = [IO.Path]::GetFullPath($ReusePreparedPayload)
    $runDirectory = [IO.Path]::GetDirectoryName($stagingDirectory)
    $sourceDirectory = Join-Path $runDirectory 'native'
}
$previousOutputs = [Collections.Generic.List[string]]::new()

function Assert-ChildPath([string]$Path, [string]$Parent) {
    $absolute = [IO.Path]::GetFullPath($Path)
    $boundary = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $absolute.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path lies outside the intended directory: $absolute (boundary: $Parent)"
    }
    return $absolute
}

function Assert-NotLink([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        if ((Get-Item -LiteralPath $Path).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "A build or release directory must not be a link: $Path"
        }
    }
}

function Remove-ControlledPath([string]$Path, [string]$Parent) {
    $absolute = Assert-ChildPath $Path $Parent
    Assert-NotLink $absolute
    if (Test-Path -LiteralPath $absolute) { Remove-Item -LiteralPath $absolute -Recurse -Force }
}

function Copy-NativeSource([string]$Source, [string]$Destination) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($entry in Get-ChildItem -LiteralPath $Source -Force) {
        if ($entry.Name -in @('bin', 'obj')) { continue }
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Native source contains a link: $($entry.FullName)" }
        if ($entry.PSIsContainer) { Copy-NativeSource $entry.FullName (Join-Path $Destination $entry.Name) }
        else { Copy-Item -LiteralPath $entry.FullName -Destination $Destination -Force }
    }
}

function Assert-PublishPayload([string]$Directory) {
    foreach ($name in @('AgentDocument.WinUI.exe', 'AgentDocument.WinUI.dll', 'AgentDocument.WinUI.pri', 'App.xbf', 'MainWindow.xbf', 'Microsoft.UI.Xaml.Controls.pri',
        'AgentDocument.WinUI.runtimeconfig.json', 'coreclr.dll', 'hostfxr.dll', 'hostpolicy.dll',
        'Microsoft.UI.Xaml.dll', 'Microsoft.WindowsAppRuntime.dll', 'WinRT.Runtime.dll')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Directory $name) -PathType Leaf)) { throw "Required native/runtime file is missing: $name" }
    }
    $runtimeConfig = Get-Content -LiteralPath (Join-Path $Directory 'AgentDocument.WinUI.runtimeconfig.json') -Raw | ConvertFrom-Json
    if (-not $runtimeConfig.runtimeOptions.PSObject.Properties['includedFrameworks']) { throw 'The .NET publish output is not self-contained.' }
    foreach ($name in @('backend/node.exe', 'backend/src/service.js', 'backend/src/mcp.js', 'backend/package.json',
        'backend/node_modules/@modelcontextprotocol/sdk/package.json', 'backend/node_modules/jszip/package.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Directory $name) -PathType Leaf)) { throw "Required backend file is missing: $name" }
    }
    foreach ($name in @('backend/src/desktop.cjs', 'backend/src/preload.cjs', 'backend/node_modules/electron/package.json')) {
        if (Test-Path -LiteralPath (Join-Path $Directory $name)) { throw "Electron desktop files must not be in the native backend: $name" }
    }
}

$nativeSource = Join-Path $projectRoot 'native'
if (-not (Test-Path -LiteralPath (Join-Path $nativeSource 'AgentDocument.WinUI/AgentDocument.WinUI.csproj') -PathType Leaf)) {
    throw 'native/AgentDocument.WinUI/AgentDocument.WinUI.csproj was not found.'
}
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw "Node runtime was not found: $NodePath" }
foreach ($directory in @($releaseRoot, $buildRootPath)) {
    Assert-NotLink $directory
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    Assert-NotLink $directory
}
[void](Assert-ChildPath $runDirectory $buildRootPath)
[void](Assert-ChildPath $stagingDirectory $runDirectory)
Assert-NotLink $runDirectory
Assert-NotLink $stagingDirectory
[void](Assert-ChildPath $releaseDirectory $releaseRoot)
Assert-NotLink $releaseDirectory
$running = @(Get-Process -Name 'AgentDocument.WinUI' -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and ([IO.Path]::GetFullPath($_.Path) -eq (Join-Path $releaseDirectory 'AgentDocument.WinUI.exe')) } catch { $false }
})
if ($running.Count -gt 0) { throw 'The previous native release is running. Close that instance before publishing.' }

if (-not $ReusePreparedPayload) {
Copy-NativeSource $nativeSource $sourceDirectory
$nativeProject = Join-Path $sourceDirectory 'AgentDocument.WinUI/AgentDocument.WinUI.csproj'
& dotnet publish $nativeProject -c Release -r win-x64 --self-contained true '-p:Platform=x64' '-p:WindowsAppSDKSelfContained=true' '-p:DebugType=None' '-p:DebugSymbols=false' -o $stagingDirectory
if ($LASTEXITCODE -ne 0) { throw "WinUI publish failed; build evidence retained at $runDirectory" }
# WinUI's generated XBF/PRI files may be excluded by the .NET publish collector.
# Copy only this run's compiled application resources, never an older build's files.
$projectXml = [xml](Get-Content -LiteralPath $nativeProject -Raw)
$targetFramework = [string](@($projectXml.Project.PropertyGroup.TargetFramework | Where-Object { $_ })[0])
$compiledDirectory = Join-Path $sourceDirectory ('AgentDocument.WinUI/bin/x64/Release/' + $targetFramework + '/win-x64')
foreach ($name in @('AgentDocument.WinUI.pri', 'App.xbf', 'MainWindow.xbf')) {
    $resourceFile = Join-Path $compiledDirectory $name
    if (-not (Test-Path -LiteralPath $resourceFile -PathType Leaf)) { throw "This run did not compile the required WinUI resource: $resourceFile" }
    Copy-Item -LiteralPath $resourceFile -Destination $stagingDirectory -Force
}
if ($FrontendOnly) {
    Assert-PublishPayload $releaseDirectory
    $oldRuntime = Get-Content -LiteralPath (Join-Path $releaseDirectory 'AgentDocument.WinUI.runtimeconfig.json') -Raw | ConvertFrom-Json
    $newRuntime = Get-Content -LiteralPath (Join-Path $stagingDirectory 'AgentDocument.WinUI.runtimeconfig.json') -Raw | ConvertFrom-Json
    if (($oldRuntime.runtimeOptions.includedFrameworks | ConvertTo-Json -Compress) -ne ($newRuntime.runtimeOptions.includedFrameworks | ConvertTo-Json -Compress)) {
        throw 'The .NET runtime changed; use a full publish rather than FrontendOnly.'
    }
    $oldDependencies = Get-Content -LiteralPath (Join-Path $releaseDirectory 'AgentDocument.WinUI.deps.json') -Raw | ConvertFrom-Json
    $newDependencies = Get-Content -LiteralPath (Join-Path $stagingDirectory 'AgentDocument.WinUI.deps.json') -Raw | ConvertFrom-Json
    $oldPackages = @($oldDependencies.libraries.PSObject.Properties | Where-Object { $_.Value.type -ne 'project' } | Select-Object -ExpandProperty Name | Sort-Object)
    $newPackages = @($newDependencies.libraries.PSObject.Properties | Where-Object { $_.Value.type -ne 'project' } | Select-Object -ExpandProperty Name | Sort-Object)
    if (($oldPackages -join "`n") -ne ($newPackages -join "`n")) { throw 'Frontend dependency packages changed; use a full publish.' }
    foreach ($file in Get-ChildItem -LiteralPath $stagingDirectory -File | Where-Object { $_.Name -like 'AgentDocument.*' -or $_.Name -in @('App.xbf', 'MainWindow.xbf') }) {
        Copy-Item -LiteralPath $file.FullName -Destination $releaseDirectory -Force
    }
    if (Test-Path -LiteralPath (Join-Path $stagingDirectory 'Assets')) {
        Copy-Item -LiteralPath (Join-Path $stagingDirectory 'Assets') -Destination $releaseDirectory -Recurse -Force
    }
    Assert-PublishPayload $releaseDirectory
    $manifestPath = Join-Path $releaseDirectory 'package-manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $manifest | Add-Member -NotePropertyName frontendUpdatedAt -NotePropertyValue ([DateTimeOffset]::Now.ToString('o')) -Force
    $manifest.fileCount = @(Get-ChildItem -LiteralPath $releaseDirectory -File -Recurse).Count
    $manifest | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $manifestPath -Encoding utf8
    Write-Host "Native frontend updated; existing backend/runtime retained: $releaseDirectory"
    Write-Host "Build evidence: $runDirectory"
    return
}

$backendDirectory = Join-Path $stagingDirectory 'backend'
New-Item -ItemType Directory -Path (Join-Path $backendDirectory 'src') -Force | Out-Null
Copy-Item -LiteralPath $NodePath -Destination (Join-Path $backendDirectory 'node.exe') -Force
foreach ($entry in Get-ChildItem -LiteralPath (Join-Path $projectRoot 'src') -File) {
    if ($entry.Name -notin @('desktop.cjs', 'preload.cjs')) { Copy-Item -LiteralPath $entry.FullName -Destination (Join-Path $backendDirectory 'src') -Force }
}
foreach ($name in @('package.json', 'package-lock.json')) { Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination $backendDirectory -Force }
& npm.cmd --prefix $backendDirectory ci --omit=dev --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'Installing backend production dependencies in the independent staging directory failed.' }
$dependencySource = 'npm ci --omit=dev --ignore-scripts in independent staging'
$backendPackage = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$backendPackage.main = 'src/service.js'
$backendPackage.scripts = [pscustomobject]@{ serve = 'node src/service.js'; mcp = 'node src/mcp.js' }
$backendPackage.PSObject.Properties.Remove('devDependencies')
$backendPackage | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $backendDirectory 'package.json') -Encoding utf8
if (Test-Path -LiteralPath (Join-Path $backendDirectory 'package-lock.json')) {
    [void](Assert-ChildPath (Join-Path $backendDirectory 'package-lock.json') $stagingDirectory)
    Remove-Item -LiteralPath (Join-Path $backendDirectory 'package-lock.json') -Force
}
} else {
    $backendDirectory = Join-Path $stagingDirectory 'backend'
    $dependencySource = 'Reused prepared production dependency payload'
}
Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE') -Destination $stagingDirectory -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'templates') -Destination $stagingDirectory -Recurse -Force
$docsDirectory = Join-Path $stagingDirectory 'docs'
New-Item -ItemType Directory -Path $docsDirectory -Force | Out-Null
foreach ($name in @('DATA-FORMAT.md', 'ARCHITECTURE.md', 'MIGRATION.md', 'MCP.md', 'WORD-IO.md', 'PERFORMANCE.md', 'REFACTOR-REPORT.md', 'WINUI.md')) {
    $document = Join-Path $projectRoot ('docs/' + $name)
    if (Test-Path -LiteralPath $document -PathType Leaf) { Copy-Item -LiteralPath $document -Destination $docsDirectory -Force }
}

Assert-PublishPayload $stagingDirectory
$runtimeConfig = Get-Content -LiteralPath (Join-Path $stagingDirectory 'AgentDocument.WinUI.runtimeconfig.json') -Raw | ConvertFrom-Json
$packageManifest = [ordered]@{
    formatVersion = 1
    createdAt = [DateTimeOffset]::Now.ToString('o')
    frontend = 'WinUI 3 native controls; no Electron frontend'
    architecture = 'x64'
    application = 'AgentDocument.WinUI.exe'
    includedDotnetFrameworks = $runtimeConfig.runtimeOptions.includedFrameworks
    windowsAppSDKSelfContained = $true
    backendNodeVersion = ((& (Join-Path $backendDirectory 'node.exe') --version) | Out-String).Trim()
    backendDependencySource = $dependencySource
    backendEntry = 'backend/src/service.js'
    mcpCommand = 'backend/node.exe'
    mcpArguments = @('backend/src/mcp.js')
    fileCount = @(Get-ChildItem -LiteralPath $stagingDirectory -File -Recurse).Count
    functionalValidation = 'Run scripts/check-winui.ps1; publishing alone is not functional validation.'
}
$packageManifest | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $stagingDirectory 'package-manifest.json') -Encoding utf8

if (Test-Path -LiteralPath $releaseDirectory) {
    $previous = Join-Path $releaseRoot ('.previous-winui-' + $runName)
    [void](Assert-ChildPath $previous $releaseRoot)
    [void](Assert-ChildPath $releaseDirectory $releaseRoot)
    Assert-NotLink $releaseDirectory
    Move-Item -LiteralPath $releaseDirectory -Destination $previous
    $previousOutputs.Add($previous)
}
[void](Assert-ChildPath $stagingDirectory $runDirectory)
[void](Assert-ChildPath $releaseDirectory $releaseRoot)
Assert-NotLink $stagingDirectory
Move-Item -LiteralPath $stagingDirectory -Destination $releaseDirectory
if ($Zip) {
    $archive = Join-Path $releaseRoot ($releaseName + '.zip')
    $stagingArchive = Join-Path $releaseRoot ('.winui-archive-' + $runName + '.zip')
    [void](Assert-ChildPath $archive $releaseRoot)
    [void](Assert-ChildPath $stagingArchive $releaseRoot)
    Compress-Archive -LiteralPath $releaseDirectory -DestinationPath $stagingArchive -CompressionLevel Optimal
    if (Test-Path -LiteralPath $archive) {
        $previousArchive = Join-Path $releaseRoot ('.previous-winui-' + $runName + '.zip')
        [void](Assert-ChildPath $previousArchive $releaseRoot)
        Move-Item -LiteralPath $archive -Destination $previousArchive
        $previousOutputs.Add($previousArchive)
    }
    Move-Item -LiteralPath $stagingArchive -Destination $archive
    Write-Host "Native portable archive: $archive"
}
if (-not $KeepPrevious) {
    foreach ($previousOutput in $previousOutputs) { Remove-ControlledPath $previousOutput $releaseRoot }
}
Write-Host "Native portable folder: $releaseDirectory"
Write-Host "Build evidence: $runDirectory"
