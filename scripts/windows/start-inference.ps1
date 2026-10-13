# Private YOLO inference service on 127.0.0.1:8001 (reads inference\.env). Ctrl+C to stop.
# Set $env:PYTHON to use a specific interpreter, e.g. .venv\Scripts\python.exe
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $root
$py = if ($env:PYTHON) { $env:PYTHON } elseif (Test-Path ".venv\Scripts\python.exe") { ".venv\Scripts\python.exe" } else { "python" }
& $py inference\service.py
