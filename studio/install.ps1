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
$py = Join-Path $venv "Scripts\python.exe"
if ((Test-Path -LiteralPath $venv) -and (-not (Test-Path -LiteralPath $py))) {
    $backup = "$venv.bak.$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
    Move-Item -LiteralPath $venv -Destination $backup
    Write-Host "Moved the existing non-Windows .venv to $backup"
}
if (-not (Test-Path -LiteralPath $py)) {
    & $uv venv --python 3.11 $venv
}
& $uv pip install --python $py -e $root
& $uv pip install --python $py "fastapi>=0.115" "uvicorn[standard]>=0.30" "python-multipart>=0.0.9"
Write-Host "Installed. Start the studio with .\run.ps1"
