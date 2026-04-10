import argparse
import json
from pathlib import Path

from datasets import load_dataset

from local_verify import read_jsonl, verify_prediction


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tasks", required=True)
    parser.add_argument("--dataset", default="princeton-nlp/SWE-bench_Lite")
    parser.add_argument("--split", default="dev")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    tasks_path = Path(args.tasks)
    tasks = read_jsonl(tasks_path)
    rows = load_dataset(args.dataset, split=args.split)
    by_id = {row["instance_id"]: row for row in rows}
    output_rows = []
    failures = []

    for task in tasks:
        instance_id = task["instanceId"]
        row = by_id.get(instance_id)
        if not row:
            output_rows.append(
                {
                    "instance_id": instance_id,
                    "ok": False,
                    "details": f"Missing dataset row for {instance_id}",
                }
            )
            failures.append(instance_id)
            continue

        patch_text = row.get("patch") or ""
        if not patch_text.strip():
            output_rows.append(
                {
                    "instance_id": instance_id,
                    "ok": False,
                    "details": "Dataset gold patch is empty",
                }
            )
            failures.append(instance_id)
            continue

        resolved, details = verify_prediction(task, patch_text)
        output_rows.append(
            {
                "instance_id": instance_id,
                "ok": resolved,
                "details": details,
            }
        )
        if not resolved:
            failures.append(instance_id)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        for row in output_rows:
            handle.write(json.dumps(row) + "\n")

    print(json.dumps({"checked": len(output_rows), "failed": len(failures), "failures": failures}, indent=2))

    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
