param(
  [switch]$RunBenchmark,
  [string]$ArtifactsDir = "artifacts/mini-swebench-local3"
)

$ErrorActionPreference = "Stop"

$baselinePredictions = Join-Path $ArtifactsDir "baseline.predictions.jsonl"
$compressedPredictions = Join-Path $ArtifactsDir "compressed.predictions.jsonl"
$runsPath = Join-Path $ArtifactsDir "runs.jsonl"
$baselineEvalPath = Join-Path $ArtifactsDir "baseline.eval.jsonl"
$compressedEvalPath = Join-Path $ArtifactsDir "compressed.eval.jsonl"
$allEvalPath = Join-Path $ArtifactsDir "all.eval.jsonl"
$tasksPath = "data/swebench-lite-local3.tasks.jsonl"

if ($RunBenchmark) {
  .\scripts\run-mini-swebench-local3.ps1
}

foreach ($requiredPath in @($baselinePredictions, $compressedPredictions, $runsPath)) {
  if (-not (Test-Path $requiredPath)) {
    throw "Required file not found: $requiredPath"
  }
}

python src/local_verify.py --tasks $tasksPath --predictions $baselinePredictions --output $baselineEvalPath
python src/local_verify.py --tasks $tasksPath --predictions $compressedPredictions --output $compressedEvalPath

Get-Content $baselineEvalPath, $compressedEvalPath | Set-Content $allEvalPath

npx tsx src/harness/benchmark-cli.ts merge-eval `
  --runs $runsPath `
  --eval $allEvalPath `
  --out $ArtifactsDir

Get-Content (Join-Path $ArtifactsDir "summary.post-eval.json")
