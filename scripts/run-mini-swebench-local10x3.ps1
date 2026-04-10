param(
  [string]$TasksPath = "data/swebench-lite-local10.tasks.jsonl",
  [string]$OutputDir = "artifacts/mini-swebench-local10x3",
  [int]$Repeats = 3,
  [string]$Python = "python",
  [string]$Model = "",
  [string]$SummarizerModel = "",
  [int]$MaxContextTokens = 20000,
  [switch]$SkipPreflight
)

$ErrorActionPreference = "Stop"

& $Python src/prepare_local_verified_tasks.py --profile local10 --output $TasksPath

if (-not $SkipPreflight) {
  & $Python src/preflight_local_tasks.py --tasks $TasksPath --output (Join-Path $OutputDir "preflight.jsonl")
}

$args = @(
  "src/harness/local10-repeat.ts",
  "--tasks", $TasksPath,
  "--out", $OutputDir,
  "--python", $Python,
  "--repeats", $Repeats.ToString(),
  "--max-context-tokens", $MaxContextTokens.ToString()
)

if ($Model) {
  $args += @("--model", $Model)
}
if ($SummarizerModel) {
  $args += @("--summarizer-model", $SummarizerModel)
}

npx tsx @args
