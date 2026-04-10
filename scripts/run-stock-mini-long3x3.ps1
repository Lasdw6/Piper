param(
  [string]$TasksPath = "data/swebench-lite-long3.tasks.jsonl",
  [string]$OutputDir = "artifacts/stock-mini-long3x3-r1",
  [string]$Python = "python",
  [string]$Model = "",
  [string]$SummarizerModel = "",
  [int]$MaxContextTokens = 15000,
  [int]$TimeoutMs = 2700000,
  [int]$Repeats = 3,
  [switch]$SkipPreflight
)

$ErrorActionPreference = "Stop"

& $Python src/prepare_local_verified_tasks.py --profile long3 --output $TasksPath
if ($LASTEXITCODE -ne 0) { throw "Task preparation failed." }

if (-not $SkipPreflight) {
  & $Python src/preflight_local_tasks.py --tasks $TasksPath --output (Join-Path $OutputDir "preflight.jsonl")
  if ($LASTEXITCODE -ne 0) { throw "Preflight failed." }
}

$args = @(
  "src/harness/stock-mini-long3-repeat.ts",
  "--tasks", $TasksPath,
  "--out", $OutputDir,
  "--python", $Python,
  "--max-context-tokens", $MaxContextTokens.ToString(),
  "--timeout-ms", $TimeoutMs.ToString(),
  "--repeats", $Repeats.ToString()
)

if ($Model) {
  $args += @("--model", $Model)
}
if ($SummarizerModel) {
  $args += @("--summarizer-model", $SummarizerModel)
}

npx tsx @args
