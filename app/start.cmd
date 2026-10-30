@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "node_modules\.bin\electron.cmd" (
  echo Не установлен Electron.
  echo Выполните в этой папке:  npm.cmd install
  pause
  exit /b 1
)

echo Запускаю labsoul (десктоп)...
call "node_modules\.bin\electron.cmd" . %*
