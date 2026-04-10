import argparse
import json
import pathlib

from huggingface_hub import hf_hub_download


def load_rows(cache_path: pathlib.Path):
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    if not cache_path.exists():
        source = hf_hub_download(repo_id="codeparrot/apps", repo_type="dataset", filename="test.jsonl")
        cache_path.write_bytes(pathlib.Path(source).read_bytes())

    with cache_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line)


def build_task(row, io):
    return {
        "instanceId": f"APPS_{row['id']}",
        "repo": "apps",
        "problemStatement": f"Solve APPS problem {row['id']}",
        "metadata": {
            "benchmark": "apps",
            "appsId": row["id"],
            "difficulty": row.get("difficulty"),
            "question": row.get("question", ""),
            "starterCode": row.get("starter_code", ""),
            "inputOutput": json.dumps(io),
            "url": row.get("url"),
            "questionLength": len(row.get("question", "")),
            "testCount": len(io.get("inputs", [])),
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--cache", default="data/apps-test.jsonl")
    parser.add_argument("--limit", type=int, default=8)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--min-question-length", type=int, default=1800)
    parser.add_argument("--min-tests", type=int, default=10)
    parser.add_argument("--difficulties", nargs="*", default=["introductory", "interview"])
    parser.add_argument("--ids", nargs="*", type=int)
    parser.add_argument("--stdin-only", action="store_true", default=True)
    args = parser.parse_args()

    output_path = pathlib.Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    rows = []
    ids = set(args.ids or [])
    for row in load_rows(pathlib.Path(args.cache)):
        try:
            io = json.loads(row["input_output"])
        except Exception:
            continue

        if ids and row["id"] not in ids:
            continue
        if not ids:
            if row.get("difficulty") not in args.difficulties:
                continue
            if len(row.get("question", "")) < args.min_question_length:
                continue
            if len(io.get("inputs", [])) < args.min_tests:
                continue
            if args.stdin_only and io.get("fn_name"):
                continue

        rows.append((len(row.get("question", "")), len(io.get("inputs", [])), row["id"], build_task(row, io)))

    rows.sort(reverse=True)
    sliced = rows[args.offset : args.offset + args.limit]

    with output_path.open("w", encoding="utf-8") as handle:
        for _, _, _, task in sliced:
            handle.write(json.dumps(task) + "\n")

    print(f"Wrote {len(sliced)} APPS tasks to {output_path}")


if __name__ == "__main__":
    main()
