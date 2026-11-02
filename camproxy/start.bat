@echo off
cd /d "%~dp0"
:loop
node server.js
echo Server stopped, restarting in 5 seconds...
timeout /t 5 >nul
goto loop
