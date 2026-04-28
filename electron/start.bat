@echo off
echo ============================================
echo FormFlow Desktop Pro — Electron App
echo ============================================

if not exist node_modules (
  echo Installing dependencies...
  npm install
)

echo Launching FormFlow Desktop Pro...
npm start
