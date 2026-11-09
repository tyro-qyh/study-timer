@echo off
chcp 65001 >nul
title 学习计时 · 安装
cd /d "%~dp0"

echo.
echo   正在安装「学习计时」……
echo   首次会下载 Electron 运行时（约 137 MB），请保持联网。
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo   安装失败。请检查网络后重试，或看 README 里的手动步骤。
  pause
  exit /b 1
)

echo.
echo   安装完成：桌面已出现「学习计时」。
echo.
pause