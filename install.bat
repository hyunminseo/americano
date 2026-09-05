@echo off
setlocal

if not exist venv (
	py -3 -m venv venv
	if errorlevel 1 exit /b 1
)

call venv\Scripts\activate.bat
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

echo.
echo Installation complete.
echo Validate with: venv\Scripts\python.exe main.py --config config.json validate
endlocal
