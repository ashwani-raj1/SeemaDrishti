$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# Avoid reinstalling packages and ending with a cryptic WinError 10048 when an
# older ANPR terminal is already serving this port. The operator must stop that
# terminal first when they want newly edited model code to be loaded.
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:8001/health" -TimeoutSec 2
  if ($health.service -eq "local-yolo-easyocr") {
    Write-Host "ANPR is already running on http://127.0.0.1:8001" -ForegroundColor Green
    Write-Host "To load new code, press Ctrl+C in the old ANPR terminal, then run this script again." -ForegroundColor Yellow
    exit 0
  }
} catch {
  # No ANPR service is listening yet; continue with normal startup.
}

$python = $null

# Windows PowerShell 5.1 does not support the PowerShell 7 null-conditional
# operator (`?.`). Prefer the project's supported Python 3.12 installation,
# then fall back to whichever `python` command is available on PATH.
$candidate = Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"
if (Test-Path -LiteralPath $candidate) {
  $python = $candidate
} else {
  $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
  if ($null -ne $pythonCommand) {
    $python = $pythonCommand.Source
  }
}
if (-not $python) { Write-Host "Python 3.11+ is required." -ForegroundColor Yellow; exit 1 }

& $python -m pip install -r requirements.txt
& $python -m uvicorn ai_service:app --host 127.0.0.1 --port 8001
