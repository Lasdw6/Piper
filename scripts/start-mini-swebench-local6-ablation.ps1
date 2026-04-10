param(
  [string]$ApiKey,
  [string]$Model = "gpt-5.4-mini",
  [string]$SummarizerModel = "gpt-4.1-mini",
  [int]$MaxContextTokens = 6000
)

$ErrorActionPreference = "Stop"

$artifactDir = Join-Path $PSScriptRoot "..\\artifacts\\mini-swebench-local6-ablation"
$stdoutLogPath = Join-Path $artifactDir "run.out.log"
$stderrLogPath = Join-Path $artifactDir "run.err.log"

if (-not (Test-Path $artifactDir)) {
  New-Item -ItemType Directory -Path $artifactDir | Out-Null
}

if (Test-Path $stdoutLogPath) {
  Remove-Item $stdoutLogPath -Force
}
if (Test-Path $stderrLogPath) {
  Remove-Item $stderrLogPath -Force
}

$command = @(
  "pwsh",
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", ('"' + (Join-Path $PSScriptRoot "run-mini-swebench-local6-ablation.ps1") + '"'),
  "-Model", $Model,
  "-SummarizerModel", $SummarizerModel,
  "-MaxContextTokens", "$MaxContextTokens"
)

if ($ApiKey) {
  $command += @("-ApiKey", ('"' + $ApiKey + '"'))
}

$process = Start-Process `
  -FilePath "cmd.exe" `
  -ArgumentList @("/c", ($command -join " ")) `
  -WorkingDirectory (Join-Path $PSScriptRoot "..") `
  -RedirectStandardOutput $stdoutLogPath `
  -RedirectStandardError $stderrLogPath `
  -PassThru

Write-Host "Started ablation run. PID: $($process.Id)"
Write-Host "Progress: artifacts/mini-swebench-local6-ablation/progress.json"
Write-Host "Logs: artifacts/mini-swebench-local6-ablation/run.out.log and run.err.log"
