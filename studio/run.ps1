<#
Starts the F5-TTS Studio server at http://127.0.0.1:7862
#>
$ErrorActionPreference = "Stop"
$studio = $PSScriptRoot
$root = Split-Path -Parent $studio
$python = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
    throw "Python environment not found at $python. Run .\install.ps1 first."
}
Set-Location -LiteralPath $studio
Write-Host "F5-TTS Studio -> http://127.0.0.1:7862"
& $python "app.py"
