# API + frontends on http://127.0.0.1:4000 (reads backend\.env, applies migrations). Ctrl+C to stop.
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location (Join-Path $root "backend")
npm start
