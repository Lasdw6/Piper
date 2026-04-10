$ErrorActionPreference = "Stop"

$artifactDir = Join-Path $PSScriptRoot "..\\artifacts\\mini-swebench-local3-ablation"
$progressPath = Join-Path $artifactDir "progress.json"
$stdoutLogPath = Join-Path $artifactDir "run.out.log"
$stderrLogPath = Join-Path $artifactDir "run.err.log"

if (Test-Path $progressPath) {
  Get-Content $progressPath
} else {
  Write-Host "No progress file yet."
}

if (Test-Path $stdoutLogPath) {
  Write-Host ""
  Write-Host "Recent stdout:"
  Get-Content $stdoutLogPath -Tail 20
}

if (Test-Path $stderrLogPath) {
  Write-Host ""
  Write-Host "Recent stderr:"
  Get-Content $stderrLogPath -Tail 20
}
