@echo off
setlocal

set "ROOT=%~dp0.."
pushd "%ROOT%" >nul

echo Americano license issuer
echo Expiry must be an ISO-8601 UTC date, for example 2026-10-07T00:00:00.000Z
echo.

set /p "MAC=MAC address: "
set /p "NAME=Issued to: "
set /p "EXPIRES=Expires at (UTC): "

if "%MAC%"=="" goto :invalid
if "%NAME%"=="" goto :invalid
if "%EXPIRES%"=="" goto :invalid

set "SAFE_MAC=%MAC::=-%"
set "OUTPUT=active_codes\license-%SAFE_MAC%.lic"

echo.
echo Output: %OUTPUT%
node scripts\license-issuer.cjs issue --mac "%MAC%" --to "%NAME%" --expires "%EXPIRES%" --out "%OUTPUT%"
if errorlevel 1 goto :failed

echo.
echo License created successfully.
popd >nul
pause
exit /b 0

:invalid
echo.
echo MAC address, issued-to name, and expiry date are required.
popd >nul
pause
exit /b 1

:failed
echo.
echo License creation failed. Check the MAC format, expiry date, and output file.
popd >nul
pause
exit /b 1