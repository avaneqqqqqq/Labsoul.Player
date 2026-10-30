# Требуется: PowerShell
<#
.SYNOPSIS
    Создаёт самоподписанный сертификат подписи кода для ЛОКАЛЬНЫХ проверок.

.DESCRIPTION
    ВАЖНО: самоподписанный сертификат НЕ заменяет настоящий.
    - На этой машине он уберёт «Unknown publisher», если добавить его в доверенные корни.
    - На чужих машинах Windows всё равно покажет предупреждение SmartScreen,
      пока сертификат не выдан удостоверяющим центром (OV/EV).

    Для распространения нужен сертификат от CA — например, Sectigo/DigiCert/GlobalSign.
    После его получения подписывайте так:
        pwsh -File tools/sign-installer.ps1 -Pfx .\cert.pfx -Password "пароль"

.EXAMPLE
    pwsh -File tools/make-test-cert.ps1
    pwsh -File tools/make-test-cert.ps1 -Trust
#>
param(
    [string]$Subject = "CN=labsoul (test), O=labsoul, C=RU",
    [string]$PfxPath = "",
    [string]$Password = "labsoul",
    [int]$Years = 2,
    [switch]$Trust
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $PfxPath) { $PfxPath = Join-Path $root "cert-test.pfx" }

$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $Subject `
    -KeyUsage DigitalSignature `
    -KeyExportPolicy Exportable `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -NotAfter (Get-Date).AddYears($Years) `
    -CertStoreLocation "Cert:\CurrentUser\My"

Write-Host "Создан сертификат:" -ForegroundColor Green
Write-Host "  Subject    : $($cert.Subject)"
Write-Host "  Thumbprint : $($cert.Thumbprint)"
Write-Host "  Действует до: $($cert.NotAfter)"

$secure = ConvertTo-SecureString -String $Password -AsPlainText -Force
Export-PfxCertificate -Cert $cert -FilePath $PfxPath -Password $secure | Out-Null
Write-Host "  PFX        : $PfxPath (пароль: $Password)" -ForegroundColor Green

if ($Trust) {
    # доверяем локально: только для тестов на этой машине
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store("Root", "CurrentUser")
    $store.Open("ReadWrite")
    $store.Add($cert)
    $store.Close()
    Write-Host "Сертификат добавлен в «Доверенные корневые центры» текущего пользователя." -ForegroundColor Yellow
    Write-Host "Теперь подпись будет считаться доверенной ТОЛЬКО на этой машине." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Подписать установщик:" -ForegroundColor Cyan
Write-Host "  pwsh -File tools/sign-installer.ps1 -Pfx `"$PfxPath`" -Password `"$Password`""
Write-Host "Удалить сертификат потом:" -ForegroundColor Cyan
Write-Host "  Remove-Item Cert:\CurrentUser\My\$($cert.Thumbprint)"
