@echo off
setlocal
title AiLabor Art Studio - installer
cd /d "%~dp0"
echo.
echo  AiLabor Art Studio - installer
echo  ==============================
echo  Step 1 of 2: the app itself (Node.js + Electron)
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js was not found.
  where winget >nul 2>nul
  if errorlevel 1 (
    echo  Install Node.js LTS from https://nodejs.org and run this script again.
    pause
    exit /b 1
  )
  echo  Installing Node.js LTS with winget...
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
)
where npm >nul 2>nul
if errorlevel 1 (
  echo  Node.js was installed, but this window cannot see it yet. Close it and run install.bat again.
  pause
  exit /b 1
)
echo  Installing dependencies (Electron, about 100 MB)...
call npm install --no-fund --no-audit
if errorlevel 1 (
  echo  npm install failed - see the messages above.
  pause
  exit /b 1
)
echo.
echo  Step 2 of 2: AI models, picked for your graphics card (every step can be skipped)
node tools\setup.mjs %*
echo.
echo  Start the app with start.bat
pause

