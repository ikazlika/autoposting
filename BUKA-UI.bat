@echo off
setlocal EnableDelayedExpansion
title Auto Posting - Dashboard UI
cd /d "%~dp0"

REM Baca PORT dari .env (default 8787)
set PORT=8787
for /f "tokens=1,2 delims==" %%a in ('findstr /R "^PORT=" .env 2^>nul') do (
  set PORT=%%b
  set PORT=!PORT: =!
)
if "%PORT%"=="" set PORT=8787

REM Cari port kosong mulai dari PORT sampai PORT+10
set TRY=%PORT%
set FREE=
for /L %%i in (0,1,10) do (
  netstat -ano | findstr ":%TRY% " | findstr "LISTENING" >nul
  if errorlevel 1 (
    set FREE=%TRY%
    goto :found
  )
  set /a TRY+=1
)
:found
if "%FREE%"=="" (
  echo Semua port %PORT% - %TRY% sibuk. Tutup aplikasi lain atau ganti PORT di .env
  pause
  exit /b 1
)
if not "%FREE%"=="%PORT%" (
  echo Port %PORT% sudah dipakai, pakai port %FREE% sebagai ganti.
  echo Tip: ubah PORT=%FREE% di .env biar permanen.
  set PORT=%FREE%
)

echo === Dashboard Auto Posting ===
echo URL: http://localhost:%PORT%
echo Tekan Ctrl+C untuk menghentikan server.
echo.

REM Set PORT env agar server pakai port yang sama
set PORT=%PORT%
REM Buka browser 1.5 detik setelah server start
start "" "http://localhost:%PORT%"
call node src/server.js
pause
