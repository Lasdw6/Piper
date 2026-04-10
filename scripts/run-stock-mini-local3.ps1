param(
  [string]$TasksPath = "data/swebench-lite-local3.tasks.jsonl",
  [string]$OutputDir = "artifacts/stock-mini-local3",
  [string]$Python = "python",
  [string]$Model = "",
  [string]$SummarizerModel = "",
  [int]$MaxContextTokens = 20000,
  [switch]$SkipPreflight
)

$ErrorActionPreference = "Stop"

& $Python src/prepare_local_verified_tasks.py --profile local3 --output $TasksPath

if (-not $SkipPreflight) {
  & $Python src/preflight_local_tasks.py --tasks $TasksPath --output (Join-Path $OutputDir "preflight.jsonl")
}

$args = @(
  "src/harness/stock-mini-local3.ts",
  "--tasks", $TasksPath,
  "--out", $OutputDir,
  "--python", $Python,
  "--max-context-tokens", $MaxContextTokens.ToString()
)

if ($Model) {
  $args += @("--model", $Model)
}
if ($SummarizerModel) {
  $args += @("--summarizer-model", $SummarizerModel)
}

npx tsx @args
