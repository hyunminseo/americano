@echo off
setlocal

echo Americano license issuer
echo Source: active_codes\ACTIVATES.md
echo Format: name MAC expiry-date (UTF-8)
echo.

 powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0issue-license.ps1"
if errorlevel 1 goto :failed
echo.
echo All licenses created successfully.
pause
exit /b 0

:failed
echo.
echo License creation failed. Check the MAC format, expiry date, and output file.
pause
exit /b 1