@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Не найден Node.js. Установите Node 22 или новее: https://nodejs.org
  pause
  exit /b 1
)

echo Запускаю labsoul...
start "" /b cmd /c "timeout /t 2 >nul & start "" http://127.0.0.1:5270"
node server\index.mjs
pause
