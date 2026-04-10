# Compression Benchmark Report

Date: 2026-04-01

## Current Algorithm

The latest stable compression path is a conservative `thresholded-hybrid` mode implemented primarily in [src/algorithm/mini_swe_agent_bridge.py](../src/algorithm/mini_swe_agent_bridge.py) and configured by [src/harness/local10-repeat.ts](../src/harness/local10-repeat.ts).

It currently does this:

- No semantic summarization in benchmark runs.
- No retrieval / archive recall in benchmark runs.
- Tool-output microcompaction only.
- High-pressure decay only after late thresholds.
- Stricter patch-source selection to avoid giant repo-wide diffs contaminating evaluation.

### Effective Policy

- `toolMicrocompactEnabled = true`
- `toolMicrocompactThresholdTokens = 60%` of the harness budget
- `toolMicrocompactKeepRecentToolMessages = 8`
- `messageDecayEnabled = true`
- `recentRawWindowTokens = 80%`
- `decayWarmStartTokens = 92%`
- `decayTargetTokens = 95%`
- `decayEmergencyTokens = 98%`
- `keepSuffixMessages = 14`
- `decayCandidateRoles = ["tool"]`

Interpretation:

- The newest tool context stays raw longer.
- Only older tool outputs are eligible for clearing.
- Decay activates very late.
- The algorithm now optimizes for “do no harm” first, savings second.

## Harness Status

The benchmark harness is now stable for local repeated runs.

Checks that passed:

- gold-patch preflight for all 10 tasks via [src/preflight_local_tasks.py](../src/preflight_local_tasks.py)
- repeated runner execution via [src/harness/local10-repeat.ts](../src/harness/local10-repeat.ts)
- 60/60 completed runs in the final benchmark
- no `run_error` rows
- no zero-token rows

Important harness fixes made during iteration:

- safer WSL git worktree handling
- persistent per-run artifacts
- better patch sanitization and validation
- patch candidate ranking that penalizes suspicious giant diffs
- filtering of non-source paths such as `.circleci/`, `.github/`, `build_tools/`, `source/`
- `git diff --ignore-cr-at-eol` to reduce CRLF noise

## Final Benchmark

Benchmark:

- 10 curated SWE-bench Lite local tasks
- 2 variants: `baseline` and `thresholded-hybrid`
- 3 repeats
- 60 total runs

Results source:

- [artifacts/mini-swebench-local10x3-fix1/summary.json](../artifacts/mini-swebench-local10x3-fix1/summary.json)

### Overall

Baseline:

- `9/30` resolved
- `30.0%` success
- `129,436.7` avg main-model tokens/run
- `$0.1109` avg cost/run

Thresholded hybrid:

- `10/30` resolved
- `33.3%` success
- `127,974.3` avg main-model tokens/run
- `$0.1101` avg cost/run

### Delta

- Success delta: `+3.3` points for hybrid
- Avg token delta: about `-1.1%` for hybrid
- Avg cost delta: slightly lower for hybrid

This means the latest version is now at least as good as baseline on correctness in this test and marginally better overall.

## Comparison To The Previous Aggressive Hybrid

Previous aggressive version:

- [artifacts/mini-swebench-local10x3/summary.json](../artifacts/mini-swebench-local10x3/summary.json)

That version produced:

- baseline `36.7%`
- hybrid `30.0%`
- hybrid token reduction `33.3%`

Interpretation:

- The aggressive version saved a lot of tokens.
- It also hurt success materially.
- It was too eager to clear context and too permissive about low-quality patch sources.

Current version:

- baseline `30.0%`
- hybrid `33.3%`
- hybrid token reduction only `1.1%`

Interpretation:

- The conservative version recovered correctness.
- Most of the large savings disappeared.
- This is a better production candidate if the requirement is “not worse than baseline.”

## Task-Level Read

From the final run:

Hybrid improved or matched on:

- `marshmallow-code__marshmallow-1343`: `0.67` vs `0.00`
- `sqlfluff__sqlfluff-2419`: `0.67` vs `0.33`
- `pydicom__pydicom-1256`: `0.67` vs `0.33`
- `marshmallow-code__marshmallow-1359`: matched at `0.67`

Hybrid was worse on:

- `pydicom__pydicom-1694`: `0.33` vs `1.00`
- `sqlfluff__sqlfluff-1733`: `0.33` vs `0.67`

Both variants still failed consistently on:

- `sqlfluff__sqlfluff-1517`
- `sqlfluff__sqlfluff-1625`
- `sqlfluff__sqlfluff-1763`
- `pydicom__pydicom-1139`

So the remaining problem is no longer “hybrid broadly breaks everything.” It is a narrower per-task behavior problem.

## Key Learnings

1. Tool-output microcompaction is the safest compression primitive.

The runs that held up best were the ones that only manipulated old tool output. Semantic summary/retrieval never became necessary to reach a stable result in these local SWE-bench tests.

2. Aggressive compression improved cost before it improved quality.

The first successful compression iterations produced large token savings, but they lost on correctness. The final stable version is the opposite: much smaller savings, but acceptable quality.

3. Patch selection was a major hidden variable.

Some early “algorithm failures” were really patch-pipeline failures:

- giant repo-wide diffs
- whole-file rewrites
- CRLF noise
- bad fallback selection of `git diff` over a cleaner `patch.txt`

Fixing patch collection materially changed benchmark outcomes.

4. Retrieval and semantic archival are still unproven.

In the stable benchmark path:

- summary-model tokens stayed at `0`
- archive count stayed at `0`
- retrieval count stayed at `0`

So the current win is not coming from the original full RAG-style compression concept yet. It is coming from a simpler Claude-style microcompact path plus harness hardening.

5. Late activation matters.

Moving the hybrid thresholds later and preserving a larger raw suffix made the algorithm much safer. This strongly supports the product thesis that small and medium tasks should remain mostly raw.

6. “At least as good as baseline” is achievable, but only with a conservative policy.

The final version meets that bar on this benchmark. It does not yet meet the stronger bar of “meaningfully cheaper while preserving success.”

## What The Current Algorithm Actually Proves

It proves:

- continual compression infrastructure can coexist with agent runs without degrading benchmark performance, if it is conservative
- tool-output-only compaction is viable
- the harness can now support repeated A/B evaluation reliably

It does not yet prove:

- semantic one-line archival plus recall improves long-horizon tasks
- summary-model driven compression is necessary
- large token savings can be obtained without hurting success

## Recommended Next Steps

1. Keep this final conservative hybrid as the stable benchmark baseline for further experiments.
2. Do not re-enable semantic retrieval in the main benchmark path yet.
3. Run a separate long-context synthetic or replay benchmark where context actually exceeds the late thresholds by a lot.
4. Optimize cost again, but only on tasks where the current hybrid already matches or beats baseline.
5. Add patch-quality heuristics directly to reporting:
   - files changed
   - changed-line count
   - whether the selected patch came from `patch.txt`, `submission`, or `git diff`

## Bottom Line

The latest compression algorithm is no longer the unstable high-savings version.

It is now:

- conservative
- tool-output focused
- late-activating
- benchmark-safe

On the latest 10-task x 3-repeat benchmark, it is slightly better than baseline on success and slightly better on cost, but only by a narrow margin. The major learning is that safety and patch integrity mattered more than aggressive compression.
