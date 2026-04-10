param(
  [switch]$RunBenchmark,
  [string]$ArtifactsDir = "artifacts/mini-swebench-dev1",
  [string]$Dataset = "princeton-nlp/SWE-bench_Lite",
  [string]$Split = "dev",
  [ValidateSet("auto", "official", "local")][string]$Mode = "auto",
  [int]$MaxWorkers = 1,
  [int]$Timeout = 1800
)

$ErrorActionPreference = "Stop"

$instanceId = "sqlfluff__sqlfluff-1625"
$baselineRunId = "mini-dev1-baseline"
$compressedRunId = "mini-dev1-compressed"
$baselinePredictions = Join-Path $ArtifactsDir "baseline.predictions.jsonl"
$compressedPredictions = Join-Path $ArtifactsDir "compressed.predictions.jsonl"
$runsPath = Join-Path $ArtifactsDir "runs.jsonl"
$baselineEvalPath = Join-Path $ArtifactsDir "baseline.eval.jsonl"
$compressedEvalPath = Join-Path $ArtifactsDir "compressed.eval.jsonl"
$allEvalPath = Join-Path $ArtifactsDir "all.eval.jsonl"
$tasksPath = "data/swebench-lite-dev1.tasks.jsonl"
$useLocalVerification = $Mode -eq "local"

if ($RunBenchmark) {
  .\scripts\run-mini-swebench-dev1.ps1
}

foreach ($requiredPath in @($baselinePredictions, $compressedPredictions, $runsPath)) {
  if (-not (Test-Path $requiredPath)) {
    throw "Required file not found: $requiredPath"
  }
}

if ($Mode -eq "official" -or $Mode -eq "auto") {
  try {
    .\scripts\run-swebench-eval-wsl.ps1 `
      -PredictionsPath $baselinePredictions `
      -RunId $baselineRunId `
      -Dataset $Dataset `
      -Split $Split `
      -InstanceIds $instanceId `
      -MaxWorkers $MaxWorkers `
      -Timeout $Timeout

    .\scripts\run-swebench-eval-wsl.ps1 `
      -PredictionsPath $compressedPredictions `
      -RunId $compressedRunId `
      -Dataset $Dataset `
      -Split $Split `
      -InstanceIds $instanceId `
      -MaxWorkers $MaxWorkers `
      -Timeout $Timeout

    python src/collect_swebench_reports.py --run-id $baselineRunId --output $baselineEvalPath
    python src/collect_swebench_reports.py --run-id $compressedRunId --output $compressedEvalPath
  } catch {
    if ($Mode -eq "official") {
      throw
    }
    $useLocalVerification = $true
    Write-Warning "Official SWE-bench grading failed. Falling back to local verification. $($_.Exception.Message)"
  }
}

if ($useLocalVerification -or (-not (Test-Path $baselineEvalPath)) -or (-not (Test-Path $compressedEvalPath))) {
  python src/local_verify.py --tasks $tasksPath --predictions $baselinePredictions --output $baselineEvalPath
  python src/local_verify.py --tasks $tasksPath --predictions $compressedPredictions --output $compressedEvalPath
}

foreach ($requiredPath in @($baselineEvalPath, $compressedEvalPath)) {
  if (-not (Test-Path $requiredPath)) {
    throw "Evaluation output not found: $requiredPath"
  }
}

Get-Content $baselineEvalPath, $compressedEvalPath | Set-Content $allEvalPath

npx tsx src/harness/benchmark-cli.ts merge-eval `
  --runs $runsPath `
  --eval $allEvalPath `
  --out $ArtifactsDir

Get-Content (Join-Path $ArtifactsDir "summary.post-eval.json")
