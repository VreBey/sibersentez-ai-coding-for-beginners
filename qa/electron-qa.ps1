# Moved to tools\electron-qa.ps1 (in git since 2026-10-09, plan D3); this keeps the old command working.
param([switch]$Visible)
& (Join-Path (Split-Path -Parent $PSScriptRoot) 'tools\electron-qa.ps1') -Visible:$Visible
exit $LASTEXITCODE
