param(
  [string]$ApiKey,
  [string]$Model = "gpt-5.4-mini",
  [string]$SummarizerModel = "gpt-4.1-mini",
  [int]$MaxContextTokens = 6000,
  [string]$Dataset = "princeton-nlp/SWE-bench_Lite",
  [string]$Split = "dev",
  [int]$MaxWorkers = 1,
  [int]$Timeout = 1800
)

.\scripts\run-mini-swebench-dev1.ps1 `
  -ApiKey $ApiKey `
  -Model $Model `
  -SummarizerModel $SummarizerModel `
  -MaxContextTokens $MaxContextTokens

.\scripts\verify-mini-swebench-dev1.ps1 `
  -ArtifactsDir "artifacts/mini-swebench-dev1" `
  -Dataset $Dataset `
  -Split $Split `
  -MaxWorkers $MaxWorkers `
  -Timeout $Timeout
