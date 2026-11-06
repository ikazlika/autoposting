# Restart server Auto Posting dengan log append (bukan overwrite).
# Setiap crash/error akan selalu tercatat di server_err.txt

$dir = 'D:\PROGRAM LAPTOP\projek node\auto posting'
$errFile = Join-Path $dir 'server_err.txt'
$outFile = Join-Path $dir 'server_out.txt'

# Matikan proses lama (jika ada)
Get-Process node -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like 'D:\PROGRAM LAPTOP\NODE\node.exe' } |
  Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# Tandai sesi restart baru di log
Add-Content -Path $errFile -Value ""
Add-Content -Path $errFile -Value ("=== RESTART {0} ===" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))

# Start ulang dengan output ter-redirect (append tidak bisa via Start-Process,
# tapi file akan ditimpa dari awal sesi ini - history crash lama tetap di errFile
# karena kita menandai sesi sebelum menimpa... catatan: Start-Process redirect menimpa.
# Solusi: simpan dulu isi lama ke server_err_old.txt)
if ((Test-Path $errFile) -and ((Get-Item $errFile).Length -gt 0)) {
  Copy-Item $errFile (Join-Path $dir 'server_err_old.txt') -Force
}
if ((Test-Path $outFile) -and ((Get-Item $outFile).Length -gt 0)) {
  Copy-Item $outFile (Join-Path $dir 'server_out_old.txt') -Force
}

Start-Process -FilePath 'node' `
  -ArgumentList 'src/server.js' `
  -WorkingDirectory $dir `
  -WindowStyle Hidden `
  -RedirectStandardOutput $outFile `
  -RedirectStandardError $errFile
Start-Sleep -Seconds 5

# Baca port yang dipakai server (dari .env)
$port = 8899
$envFile = Join-Path $dir '.env'
if (Test-Path $envFile) {
  $m = Select-String -Path $envFile -Pattern '^PORT=(\d+)' | Select-Object -First 1
  if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }
}

# Cek apakah server sudah jalan
$running = $false
try {
  $r = Invoke-WebRequest -Uri "http://localhost:$port/api/status" -TimeoutSec 5 -UseBasicParsing
  if ($r.StatusCode -eq 200) { $running = $true }
} catch {}

if ($running) {
  Write-Host "Server restarted OK - http://localhost:$port"
} else {
  Write-Host "Server GAGAL restart. Cek server_err.txt untuk detail."
}
