@echo off
title Auto Posting - Posting Sekarang
cd /d "%~dp0"
echo === Posting 1 video berikutnya sekarang ===
echo.
REM Contoh opsi:
REM   POST-NOW.bat youtube        -> hanya YouTube
REM   POST-NOW.bat facebook       -> hanya Facebook
REM   POST-NOW.bat all rotate     -> semua platform, strategi rotate
set PLATFORM=%1
set STRATEGY=%2
if "%PLATFORM%"=="" set PLATFORM=all
if "%STRATEGY%"=="" set STRATEGY=all
echo Platform: %PLATFORM%  Strategi: %STRATEGY%
call node src/post.js --now --platform=%PLATFORM% --strategy=%STRATEGY%
pause
