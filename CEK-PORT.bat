@echo off
REM Cek port yang dipakai
title Cek Port
cd /d "%~dp0"
echo === Cek Port ===
echo.
echo Port 3000:
netstat -ano | findstr ":3000"
echo.
echo Port 8787 (port baru):
netstat -ano | findstr ":8787"
echo.
echo Port lain dari .env:
for /f "tokens=2 delims==" %%a in ('findstr /R "^PORT=" .env') do (
  echo PORT=%%a
  netstat -ano | findstr ":%%a"
)
echo.
echo Jika port LISTENING, berarti dipakai. Tutup app tsb atau ganti PORT di .env
pause
