@echo off
chcp 65001 >nul
echo 正在请求管理员权限运行自签名安装脚本...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File ""%~dp0install-cert-and-sign.ps1""' -Verb RunAs"
