@echo off
title Auto Posting - Auth YouTube
cd /d "%~dp0"
echo === Dapatkan Refresh Token YouTube ===
echo Isi dulu YT_CLIENT_ID & YT_CLIENT_SECRET di .env, lalu lanjut.
call node src/get-refresh-token.js
pause
