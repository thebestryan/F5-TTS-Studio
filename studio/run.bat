@echo off
setlocal
cd /d "%~dp0"
set "PYTHON=%~dp0..\.venv\Scripts\python.exe"
if not exist "%PYTHON%" (
  echo Python environment not found. Run install.ps1 first.
  pause
  exit /b 1
)
echo F5-TTS Studio -^> http://127.0.0.1:7862
"%PYTHON%" app.py
pause
