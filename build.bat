@echo off
setlocal EnableExtensions

cd /d "%~dp0"
set "IMAGE=americano-test"

where docker >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker CLI was not found in PATH.
    exit /b 1
)

docker info >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker is not running. Start Docker Desktop and try again.
    exit /b 1
)

echo [1/2] Building Docker image: %IMAGE%
docker build --tag "%IMAGE%" .
if errorlevel 1 (
    echo [ERROR] Docker image build failed.
    exit /b 1
)

echo [2/2] Running tests in Docker...
docker run --rm "%IMAGE%"
set "TEST_EXIT_CODE=%ERRORLEVEL%"

if not "%TEST_EXIT_CODE%" == "0" (
    echo [ERROR] Docker tests failed with exit code %TEST_EXIT_CODE%.
    exit /b %TEST_EXIT_CODE%
)

echo Docker build and tests completed successfully.
exit /b 0