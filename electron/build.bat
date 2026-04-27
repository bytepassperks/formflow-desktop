@echo off
echo ============================================
echo FormFlow Desktop Pro — Build Windows Installer
echo ============================================

if not exist node_modules (
  echo Installing dependencies...
  npm install
)

echo Building Windows installer...
npm run build

echo.
echo ============================================
echo BUILD COMPLETE!
echo Check the dist/ folder for:
echo   - FormFlowDesktopPro Setup.exe (installer)
echo   - FormFlowDesktopPro.exe (portable)
echo ============================================
pause
