param(
  [string]$ApiKey,
  [string]$Model = "gpt-5.4-mini",
  [string]$SummarizerModel = "gpt-4.1-mini",
  [int]$MaxContextTokens = 6000
)

$ErrorActionPreference = "Stop"

if ($ApiKey) {
  $env:OPENAI_API_KEY = $ApiKey
}

if ((-not $env:OPENAI_API_KEY -or -not $env:BENCHMARK_MAIN_MODEL -or -not $env:BENCHMARK_SUMMARIZER_MODEL) -and (Test-Path .env)) {
  foreach ($line in Get-Content .env) {
    if ($line -match '^\s*OPENAI_API_KEY\s*=\s*(.+)\s*$' -and -not $env:OPENAI_API_KEY) {
      $env:OPENAI_API_KEY = $matches[1]
    }
    elseif ($line -match '^\s*BENCHMARK_MAIN_MODEL\s*=\s*(.+)\s*$' -and -not $env:BENCHMARK_MAIN_MODEL) {
      $env:BENCHMARK_MAIN_MODEL = $matches[1]
    }
    elseif ($line -match '^\s*BENCHMARK_SUMMARIZER_MODEL\s*=\s*(.+)\s*$' -and -not $env:BENCHMARK_SUMMARIZER_MODEL) {
      $env:BENCHMARK_SUMMARIZER_MODEL = $matches[1]
    }
  }
}

if (-not $env:OPENAI_API_KEY) {
  throw "OPENAI_API_KEY is required. Pass -ApiKey or set the environment variable."
}

if (-not $env:BENCHMARK_MAIN_MODEL) {
  $env:BENCHMARK_MAIN_MODEL = $Model
}

if (-not $env:BENCHMARK_SUMMARIZER_MODEL) {
  $env:BENCHMARK_SUMMARIZER_MODEL = $SummarizerModel
}

python src/prepare_local_verified_tasks.py --profile local6 --output data/swebench-lite-local6.tasks.jsonl

npx tsx src/harness/local6-ablation.ts `
  --tasks data/swebench-lite-local6.tasks.jsonl `
  --model $env:BENCHMARK_MAIN_MODEL `
  --summarizer-model $env:BENCHMARK_SUMMARIZER_MODEL `
  --python python `
  --max-context-tokens $MaxContextTokens `
  --out artifacts/mini-swebench-local6-ablation
