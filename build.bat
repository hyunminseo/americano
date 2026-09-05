@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
)
where node >nul 2>&1
if errorlevel 1 goto :missing_node
node -e "if (Number(process.versions.node.split('.')[0]) !== 24) process.exit(1)"
if errorlevel 1 goto :missing_node

where npm.cmd >nul 2>&1
if errorlevel 1 goto :missing_npm
call npm.cmd --version | findstr /r "^11\." >nul
if errorlevel 1 goto :missing_npm

echo [1/2] Installing dependencies...
if exist package-lock.json (
    call npm.cmd ci --include=dev
) else (
    call npm.cmd install --include=dev
)
if errorlevel 1 goto :failed

echo [2/2] Building Electron application...
call npm.cmd run build
if errorlevel 1 goto :failed
if not exist "%~dp0dist\Americano-Portable.exe" goto :failed

echo.
echo Build completed successfully.
echo Run: "%~dp0dist\Americano-Portable.exe"
echo Distribute this EXE only. No installation or config file is required.
exit /b 0

:missing_node
echo [ERROR] Node.js 24 is required. Install it and run build.bat again.
exit /b 1

:missing_npm
echo [ERROR] npm 11 is required. Install it and run build.bat again.
exit /b 1

:failed
echo [ERROR] Build failed. See the error above.
exit /b 1
