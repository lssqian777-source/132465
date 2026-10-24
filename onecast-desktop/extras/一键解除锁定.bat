@echo off
setlocal
echo ============================================
echo  OneCast - remove "downloaded from Internet" flag
echo ============================================
echo.
echo Scanning folder: %~dp0
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue; Write-Host ''; Write-Host 'Done. The SmartScreen / antivirus prompt should no longer appear.' -ForegroundColor Green"

echo.
echo You can close this window now.
pause
