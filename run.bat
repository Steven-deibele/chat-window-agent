@echo off
rem chat-window-agent no-admin launcher.
rem Uses .\node-portable\node.exe if present (extract the Node.js "Binary" zip
rem there - no installer, no admin), otherwise node/npm from PATH.
setlocal
cd /d "%~dp0"
set "NODE=node"
set "NPMCALL=npm install --no-fund --no-audit"
if exist "node-portable\node.exe" (
  set "NODE=node-portable\node.exe"
  set "NPMCALL=node-portable\node.exe node-portable\node_modules\npm\bin\npm-cli.js install --no-fund --no-audit"
)
if not exist "node_modules\exceljs" (
  echo [chat-window-agent] installing dependencies ^(user-level, no admin rights needed^)...
  call %NPMCALL% || (echo [chat-window-agent] dependency install failed - check network/proxy & exit /b 1)
)
%NODE% src\app.js %*
