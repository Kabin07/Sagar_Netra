# Local PostgreSQL 17 without a system install (embedded-postgres). Ctrl+C to stop.
# Skip this if you use a system PostgreSQL service instead.
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location (Join-Path $root "backend")
npm run db:local
