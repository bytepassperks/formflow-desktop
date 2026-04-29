@echo off
REM ============================================
REM FormFlow Desktop Pro — Quick Setup & Run
REM ============================================
REM Run this to set up and launch the app directly
REM (without building an .exe)
REM ============================================

echo [1/4] Creating virtual environment...
python -m venv venv
call venv\Scripts\activate

echo [2/4] Installing dependencies...
pip install -r requirements.txt

echo [3/4] Installing Playwright Chromium...
playwright install chromium

echo [4/4] Launching FormFlow Desktop Pro...
python main.py
