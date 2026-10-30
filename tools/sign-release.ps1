# Требуется: PowerShell
<#
.SYNOPSIS
    Подписывает собранный установщик labsoul и пересчитывает latest.yml.

.DESCRIPTION
    Почему подпись отдельным шагом: electron-builder для подписи тянет пакет
    winCodeSign, внутри которого есть macOS-симлинки, а Windows без прав
    разработчика их не создаёт. Поэтому сборка остаётся неподписанной
    (signAndEditExecutable: false), а подпись ставится здесь.

    ВАЖНО: после подписи меняется содержимое файла, поэтому sha512 в latest.yml
    и blockmap пересобираются этим же скриптом. Благодаря blockmap автообновление
    дифференциальное: клиент докачивает только изменившиеся блоки, а не все 78 МБ.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\sign-release.ps1 -Pfx .\cert.pfx -Password "пароль"
    powershell -ExecutionPolicy Bypass -File tools\sign-release.ps1 -Thumbprint <отпечаток>
#>
param(
    [string]$Pfx = "",
    [string]$Password = "",
    [string]$Thumbprint = "",
    [string]$TimestampServer = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dist = Join-Path $root "app\dist"

$installer = Get-ChildItem $dist -Filter "*-setup.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) { throw "Установщик не найден в $dist. Соберите: npm.cmd run pack" }
$exe = $installer.FullName

$cert = $null
if ($Pfx) {
    if (-not (Test-Path $Pfx)) { throw "PFX не найден: $Pfx" }
    $secure = ConvertTo-SecureString -String $Password -AsPlainText -Force
    # PowerShell 5.1 не поддерживает Get-PfxCertificate -Password: импортируем PFX в хранилище
    $cert = Import-PfxCertificate -FilePath (Resolve-Path $Pfx) -CertStoreLocation Cert:\CurrentUser\My -Password $secure
} elseif ($Thumbprint) {
    $cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $Thumbprint } | Select-Object -First 1
    if (-not $cert) { throw "Сертификат $Thumbprint не найден" }
} else {
    $cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
        Sort-Object NotAfter -Descending | Select-Object -First 1
    if (-not $cert) { throw "Нет сертификата. Создайте тестовый: tools\make-test-cert.ps1" }
}

Write-Host "Подписываю: $($installer.Name)"
Write-Host "Сертификат: $($cert.Subject) (до $($cert.NotAfter))"

Set-AuthenticodeSignature -FilePath $exe -Certificate $cert `
    -TimestampServer $TimestampServer -HashAlgorithm SHA256 | Out-Null

$check = Get-AuthenticodeSignature -FilePath $exe
Write-Host "Статус подписи: $($check.Status)" -ForegroundColor $(if ($check.Status -eq "Valid") { "Green" } else { "Yellow" })
if ($check.Status -eq "NotTrusted" -or $check.Status -eq "UnknownError") {
    Write-Host "Сертификат самоподписанный: на этой машине может быть не доверен, на чужих — тоже." -ForegroundColor Yellow
}

# --- blockmap заново: после подписи старый недействителен ---
# Именно blockmap включает дифференциальное обновление: клиент качает только
# изменившиеся блоки вместо всех 78 МБ.
$appBuilder = Join-Path $root "app\node_modules\app-builder-bin\win\x64\app-builder.exe"
$blockmap = "$exe.blockmap"
if (Test-Path $appBuilder) {
    if (Test-Path $blockmap) { Remove-Item $blockmap -Force }
    & $appBuilder blockmap --input=$exe --output=$blockmap 2>&1 | Out-Null
    if (Test-Path $blockmap) {
        Write-Host "blockmap пересобран: $([math]::Round((Get-Item $blockmap).Length / 1KB, 1)) КБ (обновления будут дифференциальными)" -ForegroundColor Green
    } else {
        Write-Host "blockmap собрать не удалось — обновление скачает установщик целиком" -ForegroundColor Yellow
    }
} else {
    Write-Host "app-builder.exe не найден — blockmap не пересобран (обновление будет полным)" -ForegroundColor Yellow
}

# --- пересчёт latest.yml под подписанный файл ---
$version = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
$bytes = [System.IO.File]::ReadAllBytes($exe)
$sha512 = [System.Security.Cryptography.SHA512]::Create()
$hash = [Convert]::ToBase64String($sha512.ComputeHash($bytes))
$size = $bytes.Length
$name = $installer.Name

$yaml = @"
version: $version
files:
  - url: $name
    sha512: $hash
    size: $size
path: $name
sha512: $hash
releaseDate: '$((Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ"))'
"@
$yamlPath = Join-Path $dist "latest.yml"
[System.IO.File]::WriteAllText($yamlPath, $yaml, (New-Object System.Text.UTF8Encoding($false)))

$sha256 = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
Write-Host ""
Write-Host "latest.yml обновлён:" -ForegroundColor Green
Write-Host "  версия : $version"
Write-Host "  размер : $size байт"
Write-Host "  sha512 : $($hash.Substring(0, 32))…"
Write-Host "  sha256 : $sha256"
Write-Host ""
Write-Host "Публиковать вместе: $name, latest.yml" -ForegroundColor Cyan
Write-Host "blockmap — тоже в релиз, иначе дифференциальное обновление не сработает." -ForegroundColor Cyan
