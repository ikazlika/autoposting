# Watchdog Auto Posting - cek server tiap 30 detik, restart kalau mati.
# Jalankan: powershell -ExecutionPolicy Bypass -File watchdog.ps1
# Atau dobel-klik: JALANKAN-WATCHDOG.bat

$dir = 'D:\PROGRAM LAPTOP\projek node\auto posting'
$log = Join-Path $dir 'watchdog.log'

function Write-Log($msg) {
  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $log -Value $line
  Write-Host $line
}

function Get-EnvPort {
  $envFile = Join-Path $dir '.env'
  if (Test-Path $envFile) {
    $m = Select-String -Path $envFile -Pattern '^PORT=(\d+)' | Select-Object -First 1
    if ($m) { return [int]$m.Matches[0].Groups[1].Value }
  }
  return 8899
}

$port = Get-EnvPort
Write-Log "=== Watchdog mulai. Pantau http://localhost:$port ==="

while ($true) {
  $alive = $false
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$port/api/status" -TimeoutSec 5 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $alive = $true }
  } catch { $alive = $false }

  if (-not $alive) {
    Write-Log "Server TIDAK merespons di port $port - mencoba restart..."
    # Matikan sisa proses node yang mungkin menggantung
    Get-Process node -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -like 'D:\PROGRAM LAPTOP\NODE\node.exe' } |
      Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    # Start ulang dengan output ke server_out/err agar crash selalu tercatat
    Start-Process -FilePath 'node' `
      -ArgumentList 'src/server.js' `
      -WorkingDirectory $dir `
      -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $dir 'server_out.txt') `
      -RedirectStandardError (Join-Path $dir 'server_err.txt')
    Start-Sleep -Seconds 6
    # Verifikasi
    try {
      $r2 = Invoke-WebRequest -Uri "http://localhost:$port/api/status" -TimeoutSec 5 -UseBasicParsing
      if ($r2.StatusCode -eq 200) { Write-Log "Server HIDUP lagi di port $port." }
      else { Write-Log "Server masih belum merespons setelah restart." }
    } catch { Write-Log "Server masih belum merespons setelah restart." }
  }
  Start-Sleep -Seconds 30
}
