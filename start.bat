@echo off
cd /d "%~dp0"
if not exist node_modules\electron (
  echo Dependencies are missing - running install.bat first.
  call install.bat
)
call npm start
