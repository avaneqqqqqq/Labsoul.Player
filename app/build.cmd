@echo off
rem Пересборка Temnikovo Dans одной кнопкой.
rem Обходит три известные проблемы: ELECTRON_RUN_AS_NODE, TEMP и права на winCodeSign.

cd /d "%~dp0"

set ELECTRON_RUN_AS_NODE=
set ELECTRON_BUILDER_CACHE=%CD%\.cache\eb
set ELECTRON_CACHE=%CD%\.cache\el
set TEMP=%CD%\.tmp
set TMP=%CD%\.tmp

if not exist ".tmp" mkdir ".tmp"
if not exist ".cache\eb" mkdir ".cache\eb"
if not exist ".cache\el" mkdir ".cache\el"

call npm.cmd install --no-audit --no-fund
if errorlevel 1 goto fail

call npm.cmd run dist
if errorlevel 1 goto fail

echo.
echo Готово. Файлы в папке dist:
dir /b dist\*.exe
pause
exit /b 0

:fail
echo.
echo Сборка не удалась. Смотри текст ошибки выше.
pause
exit /b 1
