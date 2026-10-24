# OneCast 自签名安装脚本（需以管理员身份运行）
# 作用：在本机生成代码签名证书 -> 安装为受信任发布者 -> 给 OneCast.exe 签名
# 这样 Windows 智能应用控制 / SmartScreen 不再拦截

$ErrorActionPreference = 'Stop'

# 定位脚本所在目录下的 OneCast.exe
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExePath = Join-Path $ScriptDir 'OneCast.exe'

if (-not (Test-Path $ExePath)) {
    Write-Host "找不到 OneCast.exe，请把本脚本放到 OneCast.exe 同目录后再运行。" -ForegroundColor Red
    Read-Host "按回车退出"
    exit 1
}

Write-Host "==> 生成自签名代码签名证书（有效期 10 年）..." -ForegroundColor Cyan
$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject "CN=OneCast Local Signer" `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -KeyUsage DigitalSignature `
    -NotAfter (Get-Date).AddYears(10)

Write-Host "    指纹: $($cert.Thumbprint)"

Write-Host "==> 导出证书并安装到「受信任的发布者」..." -ForegroundColor Cyan
$cerPath = Join-Path $env:TEMP "OneCast-LocalSigner.cer"
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null
Import-Certificate -FilePath $cerPath -CertStoreLocation "Cert:\CurrentUser\Root" | Out-Null
Import-Certificate -FilePath $cerPath -CertStoreLocation "Cert:\CurrentUser\Trust" | Out-Null
Remove-Item $cerPath -Force

Write-Host "==> 给 OneCast.exe 签名（带时间戳）..." -ForegroundColor Cyan
$sig = Set-AuthenticodeSignature `
    -FilePath $ExePath `
    -Certificate $cert `
    -TimestampServer "http://timestamp.digicert.com" `
    -HashAlgorithm SHA256

if ($sig.Status -eq 'Valid') {
    Write-Host "    签名成功！状态: $($sig.Status)" -ForegroundColor Green
} else {
    Write-Host "    签名状态: $($sig.Status)（时间戳服务器可能超时，不影响本机信任）" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "完成。现在双击 OneCast.exe 应该不会再被拦截。" -ForegroundColor Green
Write-Host "如果仍被智能应用控制拦截，请重启电脑后再试。" -ForegroundColor Yellow
Read-Host "按回车退出"
