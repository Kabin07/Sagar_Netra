# Opens each service in its own PowerShell window.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\start-all.ps1            (with local embedded PostgreSQL)
#   powershell -ExecutionPolicy Bypass -File scripts\windows\start-all.ps1 -SystemDb  (PostgreSQL already running as a service)
param([switch]$SystemDb)
$here = $PSScriptRoot
function Open($script) {
  Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $here $script)
}
if (-not $SystemDb) { Open "start-db.ps1"; Start-Sleep -Seconds 8 }
Open "start-inference.ps1"
Start-Sleep -Seconds 10
Open "start-backend.ps1"
Write-Host "Professional: http://127.0.0.1:4000/professional/"
Write-Host "Citizen:      http://127.0.0.1:4000/citizen/"
Write-Host "Authority:    http://127.0.0.1:4000/authority/   (admin accounts only)"
