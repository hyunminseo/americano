@echo off
setlocal

where node >nul 2>&1
if errorlevel 1 (
	echo [ERROR] Node.js 24 is required to run the Electron application.
	echo Install Node.js from https://nodejs.org/ and run install.bat again.
	exit /b 1
)

node -e "const major = Number(process.versions.node.split('.')[0]); if (major !== 24) process.exit(1)"
if errorlevel 1 (
	echo [ERROR] Node.js 24 is required. Update Node.js and run install.bat again.
	exit /b 1
)

npm.cmd install
if errorlevel 1 exit /b 1

echo.
echo Installation complete. Start with: npm start
endlocal
