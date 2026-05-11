# Flash TTGO T-Beam gateway firmware to COM7 (USB cable)
# Run from PowerShell on your local machine.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Get-Command pio -ErrorAction SilentlyContinue)) {
  throw 'PlatformIO CLI (pio) not found in PATH. Install PlatformIO Core or run from a shell where pio is available.'
}

Write-Host '[flash] Building and uploading gateway firmware to COM7...'
pio run -e gateway -t upload --upload-port COM7
Write-Host '[flash] Upload complete.'
