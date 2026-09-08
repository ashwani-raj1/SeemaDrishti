$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$python = (Get-Command python -ErrorAction SilentlyContinue)?.Source
if (-not $python) {
  $candidate = Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"
  if (Test-Path $candidate) { $python = $candidate }
}
if (-not $python) { Write-Host "Python 3.11+ is required." -ForegroundColor Yellow; exit 1 }

& $python -m pip install -r requirements.txt
& $python -m uvicorn ai_service:app --host 127.0.0.1 --port 8001
