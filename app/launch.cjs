'use strict';

/**
 * Запуск Electron с очищенным ELECTRON_RUN_AS_NODE.
 * В некоторых окружениях (IDE, оболочки, агенты) эта переменная уже стоит,
 * и electron.exe стартует как обычный node — приложение падает на require('electron').
 */

const { spawn } = require('node:child_process');
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], {
  cwd: __dirname,
  env,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error('Не удалось запустить Electron:', err.message);
  process.exit(1);
});
