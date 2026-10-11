@echo off
setlocal
cd /d "%~dp0.."

if not exist "node_modules\" (
  echo node_modules not found. Run npm install from the project folder first.
  pause
  exit /b 1
)

if not exist ".next\BUILD_ID" (
  echo No production build found. Running npm run build...
  call npm run build
  if errorlevel 1 (
    echo Build failed.
    pause
    exit /b 1
  )
)

echo Starting server at http://127.0.0.1:3000
echo Close this window or press Ctrl+C to stop.
call npm run start
