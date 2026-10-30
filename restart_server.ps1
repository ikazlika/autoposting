Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq 'D:\PROGRAM LAPTOP\NODE\node.exe' } | Stop-Process -Force
Start-Sleep -Seconds 1
Start-Process -FilePath 'node' -ArgumentList 'src/server.js' -WorkingDirectory 'D:\PROGRAM LAPTOP\projek node\auto posting' -WindowStyle Hidden
Start-Sleep -Seconds 4
Write-Host 'Server restarted'
