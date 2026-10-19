# SAGAR-NETRA one-time setup (Windows PowerShell).
#   powershell -ExecutionPolicy Bypass -File scripts\windows\setup.ps1
#
# - checks Node.js and Python + ultralytics
# - installs backend npm dependencies
# - creates backend\.env and inference\.env from the examples ONLY IF THEY DO NOT EXIST,
#   with freshly generated JWT_SECRET and a shared inference token
# Existing .env files are never modified.
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $root

function Need($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Write-Host "MISSING: $cmd - $hint" -ForegroundColor Red; exit 1 }
}
Need node "install Node.js 20+ from https://nodejs.org"
Need python "install Python 3.10+ from https://python.org"
Write-Host "Node $(node -v)"
python -c "import ultralytics, cv2, numpy; print('Python OK, ultralytics', ultralytics.__version__)"
if ($LASTEXITCODE -ne 0) {
  Write-Host "Python packages missing. Run:  python -m pip install -r inference\requirements.txt" -ForegroundColor Yellow
}
if (-not (Test-Path "runs\sagarnetra_turbid_v4\weights\best.pt")) {
  Write-Host "WARNING: runs\sagarnetra_turbid_v4\weights\best.pt not found - set SN_MODEL_PATH in inference\.env" -ForegroundColor Yellow
}

Push-Location backend
npm install
Pop-Location

# UTF-8 without BOM (Windows PowerShell 5.1's Set-Content -Encoding utf8 adds one)
function Write-Utf8([string]$path) {
  begin { $lines = @() } process { $lines += $_ }
  end { [IO.File]::WriteAllLines((Join-Path $root $path), [string[]]$lines, (New-Object Text.UTF8Encoding($false))) }
}

$token = node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
$jwt   = node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

if (Test-Path "backend\.env") {
  Write-Host "backend\.env exists - left unchanged. Compare it with backend\.env.example for new settings."
} else {
  (Get-Content "backend\.env.example") `
    -replace '^JWT_SECRET=.*$', "JWT_SECRET=$jwt" `
    -replace '^INFERENCE_TOKEN=.*$', "INFERENCE_TOKEN=$token" | Write-Utf8 "backend\.env"
  Write-Host "Created backend\.env - now set DATABASE_URL in it." -ForegroundColor Green
}
if (Test-Path "inference\.env") {
  Write-Host "inference\.env exists - left unchanged. SN_INFERENCE_TOKEN must equal INFERENCE_TOKEN in backend\.env."
} else {
  (Get-Content "inference\.env.example") -replace '^SN_INFERENCE_TOKEN=.*$', "SN_INFERENCE_TOKEN=$token" | Write-Utf8 "inference\.env"
  Write-Host "Created inference\.env (token shared with backend\.env)." -ForegroundColor Green
}
Write-Host "`nNext: set DATABASE_URL in backend\.env (or run scripts\windows\start-db.ps1 and copy the URL it prints), then scripts\windows\start-all.ps1"
