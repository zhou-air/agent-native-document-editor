@echo off
setlocal
cd /d "%~dp0"
set "AGENTDOC_RUNTIME=%~dp0.runtime-local"
set "AGENTDOC_PORT=47831"
if not exist "%~dp0release\AgentDocument-WinUI-x64\AgentDocument.WinUI.exe" (
  echo Native application was not found. Run scripts\publish-winui.ps1 first.
  pause
  exit /b 1
)
start "" "%~dp0release\AgentDocument-WinUI-x64\AgentDocument.WinUI.exe" --workspace "%~dp0." --runtime "%~dp0.runtime-local" --port 47831
exit /b 0
