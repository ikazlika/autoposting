@echo off
REM Install dependencies
title Auto Posting - Install
cd /d "%~dp0"
echo === Install dependencies ===
call npm install
if errorlevel 1 (
  echo Gagal install. Cek koneksi / Node.js.
  pause
  exit /b 1
)
echo.
echo Selesai. Jalankan BUKA-UI.bat untuk membuka dashboard.
pause
