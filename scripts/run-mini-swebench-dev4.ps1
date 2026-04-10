param(
  [string]$ApiKey,
  [string]$Model = "gpt-5.4-mini",
  [string]$SummarizerModel = "gpt-4.1-mini"
)

if ($ApiKey) {
  $env:OPENAI_API_KEY = $ApiKey
}

if (-not $env:OPENAI_API_KEY -and (Test-Path .env)) {
  foreach ($line in Get-Content .env) {
    if ($line -match '^\s*OPENAI_API_KEY\s*=\s*(.+)\s*$') {
      $env:OPENAI_API_KEY = $matches[1]
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

npm run bench:mini:dev4
