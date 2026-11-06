@echo off
title Auto Posting - Watchdog (Auto-Restart)
cd /d "%~dp0"
echo === Watchdog Auto Posting ===
echo Watching server every 30 seconds.
echo Log: watchdog.log
echo Tekan Ctrl+C untuk menghentikan.
powershell -ExecutionPolicy Bypass -File "%~dp0watchdog.ps1"
pause
