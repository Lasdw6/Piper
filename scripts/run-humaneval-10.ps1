Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = "C:\Desktop\Compressor"
Set-Location $root

python scripts\prepare_humaneval.py --output data\humaneval-10.tasks.jsonl --limit 10

npx tsx src\benchmark-cli.ts run `
  --tasks data\humaneval-10.tasks.jsonl `
  --agent command `
  --cmd npx `
  --cmd-arg tsx `
  --cmd-arg src\humaneval-agent.ts `
  --model gpt-5.4-mini `
  --summarizer-model gpt-4.1-mini `
  --max-context-tokens 1400 `
  --out artifacts\humaneval-10
