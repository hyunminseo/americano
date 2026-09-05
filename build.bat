@echo off
setlocal

cd /d "%~dp0"
echo Building Electron application with Node.js 24...
npm.cmd run build
if errorlevel 1 exit /b 1

echo Build completed successfully.
endlocal