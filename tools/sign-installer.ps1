# Требуется: PowerShell
<#
.SYNOPSIS
    Подписывает установщик labsoul сертификатом подписи кода.

.DESCRIPTION
    Работает без Windows SDK: используется встроенный Set-AuthenticodeSignature,
    поэтому достаточно .pfx-файла (или сертификата в хранилище CurrentUser\My).

    Для распространения нужен НАСТОЯЩИЙ сертификат (OV/EV) от удостоверяющего центра.
    Самоподписанный годится только для локальной проверки — на чужих машинах
    Windows ему не доверяет (см. make-test-cert.ps1).

.EXAMPLE
    pwsh -File tools/sign-installer.ps1 -Pfx .\cert.pfx -Password "пароль"

.EXAMPLE
    # сертификат уже в хранилище
    pwsh -File tools/sign-installer.ps1 -Thumbprint ABC123...
#>
param(
    [string]$File = "",
    [string]$Pfx = "",
    [string]$Password = "",
    [string]$Thumbprint = "",
    [string]$TimestampServer = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not $File) {
    $candidates = Get-ChildItem (Join-Path $root "app\dist") -Filter "*-setup.exe" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending
    if (-not $candidates) {
        throw "Установщик не найден в app\dist. Соберите его: npm.cmd run pack"
    }
    $File = $candidates[0].FullName
}

if (-not (Test-Path $File)) { throw "Файл не найден: $File" }

$cert = $null
if ($Pfx) {
    if (-not (Test-Path $Pfx)) { throw "PFX не найден: $Pfx" }
    $secure = ConvertTo-SecureString -String $Password -AsPlainText -Force
    # PowerShell 5.1 не поддерживает Get-PfxCertificate -Password: импортируем PFX в хранилище
    $cert = Import-PfxCertificate -FilePath (Resolve-Path $Pfx) -CertStoreLocation Cert:\CurrentUser\My -Password $secure
} elseif ($Thumbprint) {
    $cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $Thumbprint } | Select-Object -First 1
    if (-not $cert) { throw "Сертификат с отпечатком $Thumbprint не найден в CurrentUser\My" }
} else {
    # последний подходящий сертификат подписи кода в хранилище
    $cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
        Sort-Object NotAfter -Descending | Select-Object -First 1
    if (-not $cert) {
        throw "Нет сертификата. Укажите -Pfx/-Password или -Thumbprint, либо создайте тестовый: tools\make-test-cert.ps1"
    }
}

Write-Host "Сертификат : $($cert.Subject)"
Write-Host "Действует до: $($cert.NotAfter)"
Write-Host "Файл        : $File"

$result = Set-AuthenticodeSignature -FilePath $File -Certificate $cert `
    -TimestampServer $TimestampServer -HashAlgorithm SHA256

if ($result.Status -ne "Valid" -and $result.Status -ne "UnknownError") {
    Write-Host "Статус подписи: $($result.Status)" -ForegroundColor Yellow
}

$check = Get-AuthenticodeSignature -FilePath $File
Write-Host ""
Write-Host "Итог: $($check.Status)" -ForegroundColor $(if ($check.Status -eq "Valid") { "Green" } else { "Yellow" })
Write-Host "Подписал: $($check.SignerCertificate.Subject)"
if ($check.Status -eq "UnknownError") {
    Write-Host "Подпись добавлена. «UnknownError» означает, что корневой сертификат не в доверенных на этой машине." -ForegroundColor Yellow
}
if ($check.Status -eq "NotTrusted") {
    Write-Host "Самоподписанный сертификат: Windows не доверяет ему на других машинах." -ForegroundColor Yellow
    Write-Host "Для распространения нужен сертификат OV/EV от удостоверяющего центра." -ForegroundColor Yellow
}
