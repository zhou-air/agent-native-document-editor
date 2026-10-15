[CmdletBinding()]
param([string]$ProjectPath)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$executable = Join-Path $workspace 'release\AgentDocument-WinUI-x64\AgentDocument.WinUI.exe'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw '请先运行 scripts\publish-winui.ps1 生成原生文档工作台。' }
$runtime = Join-Path $workspace '.runtime-local'
$arguments = @('--workspace', ('"' + $workspace + '"'), '--runtime', ('"' + $runtime + '"'), '--port', '47831')
if ($ProjectPath) { $arguments += @('--project', ('"' + [IO.Path]::GetFullPath($ProjectPath) + '"')) }
# This is the interactive application the user is starting.
Start-Process -FilePath $executable -ArgumentList $arguments -WorkingDirectory $workspace -WindowStyle Normal | Out-Null
