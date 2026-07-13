# Piper

**Piper** is a research codebase for **active context compression** during long-horizon coding-agent runs. It asks whether an agent should continually maintain a useful working set instead of waiting until the context window is full and compacting the entire history at once.

The repository separates the **compression algorithm** (how context is preserved, shortened, archived, or cleared) from the **evaluation harness** (how baseline and compressed agents are executed and scored).

## Research question

Most agent compaction is reactive: append messages until the context limit is near, summarize a large section of history, then continue from that summary. This creates a sharp transition between a raw transcript and a compressed one, and it asks one late summary to preserve every detail that might matter later.

Piper explores a different model. On each turn, the agent constructs a bounded working set from the full event history. Recent context remains verbatim, while older context becomes progressively cheaper according to its age, role, and task phase. The target is not the smallest possible prompt. It is a context window that retains the most useful information throughout a long run.

The full design contains four compression layers:

1. **Tool-output microcompaction** removes the payloads of older, verbose tool results while retaining their role and outcome. Recent tool calls remain untouched.
2. **Age-based message decay** shortens eligible older messages using Fibonacci-style age buckets while protecting the system prompt, user messages, and a recent raw-token window.
3. **Phase compression** replaces completed task phases with small compression keys containing a summary and references to the source events.
4. **Archive recall** can retrieve compressed phase information when the agent's current work overlaps with an older phase.

```text
full event history
        |
        v
protect system + current work + recent raw window
        |
        v
clear stale tool payloads -> decay older messages -> summarize completed phases
        |
        v
bounded working set for the next model turn
```

Implementation:

| Piece | Role |
| --- | --- |
| [`src/algorithm/mini_swe_agent_bridge.py`](src/algorithm/mini_swe_agent_bridge.py) | LiteLLM / mini-swe-agent integration through `CompressedLitellmModel`; implements passthrough, tool microcompaction, phase archival and recall, decay, and decision traces. |
| [`src/algorithm/compression.ts`](src/algorithm/compression.ts) | TypeScript reference implementation for phase keys, age-based decay, recent-window protection, and threshold enforcement. |

## What is currently validated

The complete active-compression design is implemented as a research path, but the stable benchmark policy is deliberately narrower. Semantic summarization and archive recall have not yet demonstrated a reliable benefit, so the latest benchmark disables them and validates the safest subset first.

## Algorithm: thresholded hybrid (production path)

The stable policy used in recent benchmarks is a conservative **`thresholded-hybrid`** mode:

- **No** semantic summarization and **no** retrieval / archive recall on the benchmark path (those counters stay at zero).
- **Tool-output microcompaction** is the main lever: when total estimated tokens cross a threshold, **older** tool outputs are cleared or stubbed while **recent** tool messages stay intact.
- **Message decay** (Fibonacci-style shrinking of eligible roles) runs only **late**—after warm-start and emergency thresholds—so short and medium runs stay mostly raw.
- **Phase compression** is disabled for these runs; the win comes from a Claude-style microcompact path plus careful thresholds, not from phase summaries.

### Effective parameters (typical harness budget)

With `maxContextTokens` set by the harness (often **20_000** in repeat scripts), the hybrid variant in [`src/harness/local10-repeat.ts`](src/harness/local10-repeat.ts) applies approximately:

| Setting | Typical value |
| --- | --- |
| `toolMicrocompactEnabled` | `true` |
| `toolMicrocompactThresholdTokens` | **60%** of max context |
| `toolMicrocompactKeepRecentToolMessages` | **8** |
| `messageDecayEnabled` | `true` |
| `recentRawWindowTokens` | **80%** of max context |
| `decayWarmStartTokens` | **92%** |
| `decayTargetTokens` | **95%** |
| `decayEmergencyTokens` | **98%** |
| `keepSuffixMessages` | **14** |
| `decayCandidateRoles` | `["tool"]` |

Interpretation: the **newest** tool context stays raw the longest; only **older** tool outputs are eligible for clearing; decay activates **very late**. The validated policy optimizes for *do no harm* first, token savings second.

## Benchmark numbers (SWE-bench Lite–style local set)

**Setup:** 10 curated local SWE-bench Lite tasks, two variants (`baseline` vs `thresholded-hybrid`), **3** repeats each → **60** completed runs.

**Source:** `artifacts/mini-swebench-local10x3-fix1/summary.json` (see also [`reports/latest-compression-report.md`](reports/latest-compression-report.md)).

| Variant | Resolved (of 30) | Success rate | Avg main-model tokens / run | Avg cost / run |
| --- | ---: | ---: | ---: | ---: |
| **Baseline** | 9 | 30.0% | ~129,437 | ~$0.1109 |
| **Thresholded hybrid** | 10 | 33.3% | ~127,974 | ~$0.1101 |

**Deltas (hybrid − baseline):** about **+3.3** percentage points on success, about **−1.1%** main-model tokens, slightly lower average cost.

**Earlier aggressive hybrid** (for contrast): larger token savings (~33% reduction) but **lower** success than baseline; the current conservative policy trades most of that savings to recover correctness. Details are in the report file above.

## Repository layout

```
src/
  algorithm/          # Compression logic (Python bridge + TS core)
  harness/            # Benchmark runners, adapters, JSONL I/O, UI for artifacts
  lab.ts, cli.ts, …   # Offline lab, scenarios, optional OpenAI-backed demos
data/                 # Task lists (.jsonl)
scripts/              # PowerShell helpers for local SWE-bench runs
reports/              # Human-readable benchmark write-ups
artifacts/            # Run outputs (gitignored by default)
```

**Harness entry points:**

- [`src/harness/benchmark-cli.ts`](src/harness/benchmark-cli.ts) — general paired runs (`mock`, `command`, `mini-swe-agent`).
- [`src/harness/local10-repeat.ts`](src/harness/local10-repeat.ts) — 10-task × repeat baseline vs `thresholded-hybrid` with aggregated summary JSON.

## Quick start

```bash
npm install
npm run demo
```

Optional OpenAI-backed demo:

```bash
$env:OPENAI_API_KEY="your-key"   # PowerShell
npm run live:demo
```

Dry-run the benchmark pipeline (mock agent):

```bash
npm run bench:demo
```

Run the benchmark CLI with a real agent command:

```bash
tsx src/harness/benchmark-cli.ts run \
  --tasks data/sample-benchmark-tasks.jsonl \
  --agent command \
  --cmd "python your_agent_runner.py" \
  --out artifacts/real-bench
```

`mini-swe-agent` tasks need `workspacePath` (local) or `dockerImage` (container). Example:

```bash
tsx src/harness/benchmark-cli.ts run \
  --tasks path/to/mini-swe-agent-tasks.jsonl \
  --agent mini-swe-agent \
  --model gpt-4.1-mini \
  --python python \
  --out artifacts/mini-swe-agent
```

Prepare a small SWE-bench Lite subset and run:

```bash
python src/prepare_swebench_tasks.py \
  --output data/swebench-lite-dev4.tasks.jsonl \
  --workspace-root workspaces/swebench-lite-dev4 \
  --clone

tsx src/harness/benchmark-cli.ts run \
  --tasks data/swebench-lite-dev4.tasks.jsonl \
  --agent mini-swe-agent \
  --model gpt-4.1-mini \
  --python python \
  --out artifacts/mini-swebench-dev4
```

After official evaluation, merge eval results:

```bash
tsx src/harness/benchmark-cli.ts merge-eval \
  --runs artifacts/real-bench/runs.jsonl \
  --eval path/to/eval-results.jsonl \
  --out artifacts/real-bench
```

### Command adapter contract

The harness sets `BENCHMARK_TASK_PATH`, `BENCHMARK_RESULT_PATH`, and `BENCHMARK_VARIANT_ID`. Your agent must read the task JSON and write a JSON result with `patch`, `usage`, and optional `turnUsages` (see previous inline examples in task-oriented scripts under `scripts/`).

## Notes

- The TypeScript **lab** works offline by default; OpenAI is optional for live demos.
- The **`mini-swe-agent` adapter** invokes [`src/algorithm/mini_swe_agent_bridge.py`](src/algorithm/mini_swe_agent_bridge.py) and aggregates per-call usage from the trajectory into run-level totals.
- **`prepare_swebench_tasks.py`** can clone repos at the task base commit for local verification workflows.
