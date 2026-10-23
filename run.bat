@echo off
rem chat-window-agent no-admin launcher.
rem Assumes Node.js may NOT be installed: uses .\node-portable\ if present,
rem otherwise node from PATH, otherwise downloads a portable Node automatically
rem (user-level, no installer, no admin - just PowerShell, present on all Windows).
setlocal
cd /d "%~dp0"

set "NODEVER=v22.14.0"
set "NODE="
if exist "node-portable\node.exe" set "NODE=node-portable\node.exe"
if not defined NODE (
  where node >nul 2>nul && set "NODE=node"
)
if not defined NODE (
  echo [chat-window-agent] Node.js not found - downloading portable Node %NODEVER% ^(no admin needed^)...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; $zip=\"$env:TEMP\node-%NODEVER%-win-x64.zip\"; Invoke-WebRequest -Uri 'https://nodejs.org/dist/%NODEVER%/node-%NODEVER%-win-x64.zip' -OutFile $zip; Expand-Archive -Path $zip -DestinationPath \"$env:TEMP\node-portable-x\" -Force; if (Test-Path 'node-portable') { Remove-Item -Recurse -Force 'node-portable' }; Move-Item \"$env:TEMP\node-portable-x\node-%NODEVER%-win-x64\" 'node-portable'; Remove-Item $zip" || (echo [chat-window-agent] portable Node download failed - check network/proxy & exit /b 1)
  set "NODE=node-portable\node.exe"
)

if "%NODE%"=="node" (
  set "NPMCALL=npm install --no-fund --no-audit"
) else (
  set "NPMCALL=%NODE% node-portable\node_modules\npm\bin\npm-cli.js install --no-fund --no-audit"
)
if not exist "node_modules\exceljs" set "NEEDINSTALL=1"
if not exist "node_modules\node-llama-cpp" set "NEEDINSTALL=1"
if defined NEEDINSTALL (
  echo [chat-window-agent] installing dependencies ^(user-level, no admin rights needed^)...
  call %NPMCALL% || (echo [chat-window-agent] dependency install failed - check network/proxy & exit /b 1)
)
%NODE% src\app.js %*
