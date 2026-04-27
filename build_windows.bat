@echo off
REM ============================================
REM FormFlow Desktop Pro — Windows Build Script
REM ============================================
REM Run this on your Windows machine to build the .exe
REM Prerequisites: Python 3.9+ installed
REM ============================================

echo [1/5] Creating virtual environment...
python -m venv venv
call venv\Scripts\activate

echo [2/5] Installing dependencies...
pip install -r requirements.txt

echo [3/5] Installing Playwright Chromium (fallback browser)...
playwright install chromium

echo [4/5] Downloading bundled Chromium for embedding...
python -c "import asyncio; from automation.chromium_manager import ChromiumManager; asyncio.run(ChromiumManager().download(lambda d,t: print(f'Downloaded {d/1024/1024:.1f}MB / {t/1024/1024:.1f}MB') if t else None))"

echo [5/5] Building FormFlowDesktopPro.exe with PyInstaller...
pyinstaller formflow.spec

echo.
echo ============================================
echo BUILD COMPLETE!
echo Your executable is at: dist\FormFlowDesktopPro.exe
echo ============================================
pause
