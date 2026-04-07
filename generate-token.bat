@echo off
chcp 65001 >nul
title 生成32位授权Token

:: 生成32位随机Token
setlocal EnableDelayedExpansion

:: 使用PowerShell生成32位随机字符串（包含大小写字母和数字）
for /f "tokens=*" %%a in ('powershell -Command "-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })"') do (
    set "TOKEN=%%a"
)

echo ==========================================
echo          32位授权Token生成器
echo ==========================================
echo.
echo 生成的Token: %TOKEN%
echo.
echo Token长度: 32位
echo.
echo ==========================================

:: 复制到剪贴板
echo %TOKEN% | clip
echo Token已复制到剪贴板！
echo.

pause
