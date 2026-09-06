@echo off
setlocal
cd /d "%~dp0"

echo Checking Node.js and npm...
where node >nul 2>&1
if errorlevel 1 goto :missing_node
node -e "if (Number(process.versions.node.split('.')[0]) !== 24) process.exit(1)"
if errorlevel 1 goto :missing_node

where npm.cmd >nul 2>&1
if errorlevel 1 goto :missing_npm
call npm.cmd --version | findstr /r "^11\." >nul
if errorlevel 1 goto :missing_npm

echo Detecting this PC's MAC address...
for /f "delims=" %%M in ('node -e "require('./src/license').readDeviceMacs().then(macs => { if (!macs.length) process.exit(1); process.stdout.write(macs[0]); }).catch(() => process.exit(1))"') do set "MAC=%%M"
if not defined MAC goto :missing_mac

echo Using MAC: %MAC%
echo Installing dependencies...
if exist package-lock.json (
    call npm.cmd ci --include=dev
) else (
    call npm.cmd install --include=dev
)
if errorlevel 1 goto :failed

echo Building MAC comparison executables...
call npm.cmd run build:license-compare -- --mac "%MAC%"
if errorlevel 1 goto :failed
if not exist "%~dp0dist\license-comparison\mac-match\Americano-MyMAC.exe" goto :failed
if not exist "%~dp0dist\license-comparison\mac-mismatch\Americano-OtherMAC.exe" goto :failed

echo.
echo MAC comparison builds completed successfully.
echo Match:    "%~dp0dist\license-comparison\mac-match\Americano-MyMAC.exe"
echo Mismatch: "%~dp0dist\license-comparison\mac-mismatch\Americano-OtherMAC.exe"
exit /b 0

:missing_node
echo [ERROR] Node.js 24 is required. Install it and run this batch file again.
exit /b 1

:missing_npm
echo [ERROR] npm 11 is required. Install it and run this batch file again.
exit /b 1

:missing_mac
echo [ERROR] No usable MAC address was found on this PC.
exit /b 1

:failed
echo [ERROR] Build failed. See the error above.
exit /b 1
