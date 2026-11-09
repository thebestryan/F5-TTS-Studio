<#
Creates the Python 3.11 environment and installs F5-TTS plus studio dependencies.
Run from anywhere; paths are resolved relative to this script.
#>
$ErrorActionPreference = "Stop"
$studio = $PSScriptRoot
$root = Split-Path -Parent $studio
$venv = Join-Path $root ".venv"
$uv = Join-Path $env:USERPROFILE ".local\bin\uv.exe"
if (-not (Test-Path -LiteralPath $uv)) {
    $uv = "uv"
}
Set-Location -LiteralPath $root
if (-not (Test-Path -LiteralPath (Join-Path $venv "Scripts\python.exe"))) {
    & $uv venv --python 3.11 $venv
}
& $uv pip install --python (Join-Path $venv "Scripts\python.exe") -e $root
& $uv pip install --python (Join-Path $venv "Scripts\python.exe") "fastapi>=0.115" "uvicorn[standard]>=0.30" "python-multipart>=0.0.9"
Write-Host "Installed. Start the studio with .\run.ps1"
