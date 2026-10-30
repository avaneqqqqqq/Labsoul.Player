@echo off
rem Запуск приложения Яндекс Музыка (обёртка с темой)
rem Двойной клик по этому файлу. Окно консоли можно свернуть.

cd /d "%~dp0"

rem В некоторых средах ELECTRON_RUN_AS_NODE=1 — тогда Electron стартует как node
set ELECTRON_RUN_AS_NODE=

if not exist "node_modules\electron\dist\electron.exe" (
  echo Не найден Electron. Устанавливаю зависимости...
  call npm.cmd install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo Не удалось установить зависимости. Запустите вручную: npm install
    pause
    exit /b 1
  )
)

node launch.cjs
if errorlevel 1 pause
