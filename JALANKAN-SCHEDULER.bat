@echo off
title Auto Posting - Scheduler Terjadwal
cd /d "%~dp0"
echo === Scheduler (terjadwal) ===
echo Jadwal dari .env POST_SCHEDULE (default: 0 10,18 * * *)
echo Tekan Ctrl+C untuk berhenti.
call node src/scheduler.js
pause
