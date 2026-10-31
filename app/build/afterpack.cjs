'use strict';

/**
 * afterPack-хук electron-builder: впечатывает в labsoul.exe свою иконку,
 * название и версию.
 *
 * Почему отдельный хук: сборка идёт с `signAndEditExecutable: false`
 * (встроенная правка ресурсов тянет пакет winCodeSign с macOS-симлинками,
 * которые Windows без прав разработчика не создаёт). Поэтому ресурсы правим
 * сами через повторную сборку PE-ресурсов пакетом resedit — чистыv JS, без
 * внешних утилит и без прав администратора.
 *
 * Хук выполняется до сборки установщика, поэтому NSIS кладёт внутрь уже
 * исправленный exe, а подпись ставится позже (tools/sign-release.ps1).
 */

const fs = require('node:fs');
const path = require('node:path');
const ResEdit = require('resedit');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const exeName = 'labsoul.exe';
  const exePath = path.join(context.appOutDir, exeName);
  const iconPath = path.join(__dirname, 'icon.ico');

  if (!fs.existsSync(exePath)) {
    console.warn('[afterpack] exe не найден:', exePath);
    return;
  }
  if (!fs.existsSync(iconPath)) {
    console.warn('[afterpack] иконка не найдена:', iconPath);
    return;
  }

  const version = String(context.packager?.appInfo?.version || '0.0.0');
  const parts = version.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [major = 0, minor = 0, patch = 0] = parts;

  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  // 1. иконки
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath));
  const iconData = iconFile.icons.map((icon) => icon.data);
  // у Electron в exe несколько групп иконок с разными id — меняем все,
  // иначе Windows продолжит показывать атом из соседней группы
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  if (groups.length) {
    for (const group of groups) {
      ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group.id, group.lang, iconData);
    }
  } else {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, iconData);
  }

  // 2. версия и подписи в свойствах файла
  const versionInfos = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  for (const info of versionInfos) {
    info.setFileVersion(major, minor, patch, 0, 1033);
    info.setProductVersion(major, minor, patch, 0, 1033);
    info.setStringValues(
      { lang: 1033, codepage: 1200 },
      {
        ProductName: 'labsoul',
        FileDescription: 'labsoul — музыкальный плеер',
        CompanyName: 'labsoul',
        LegalCopyright: 'MIT',
        OriginalFilename: exeName,
        InternalName: 'labsoul',
        FileVersion: version,
        ProductVersion: version,
      },
      true,
    );
    info.outputToResourceEntries(res.entries);
  }

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log(`[afterpack] ресурсы exe обновлены: labsoul ${version}`);

  // Подписываем сам labsoul.exe, а не только установщик: неподписанный
  // Electron-бинарник вызывает ложные срабатывания антивирусов.
  const signScript = path.join(__dirname, '..', '..', 'tools', 'sign-installer.ps1');
  const pfxPath = path.join(__dirname, '..', '..', 'cert-test.pfx');
  if (!fs.existsSync(signScript) || !fs.existsSync(pfxPath)) {
    console.warn('[afterpack] сертификат не найден — exe останется неподписанным');
    return;
  }
  try {
    const { execFileSync } = require('node:child_process');
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', signScript,
        '-File', exePath, '-Pfx', pfxPath, '-Password', 'labsoul'],
      { stdio: 'inherit' },
    );
    console.log('[afterpack] labsoul.exe подписан');
  } catch (err) {
    console.warn('[afterpack] подпись exe не удалась:', err.message);
  }
};
