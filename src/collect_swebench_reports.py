import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--logs-root", default="logs/run_evaluation")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    run_root = Path(args.logs_root) / args.run_id
    rows = []
    if not run_root.exists():
      raise SystemExit(f"Run log directory not found: {run_root}")

    for model_dir in sorted(path for path in run_root.iterdir() if path.is_dir()):
        for instance_dir in sorted(path for path in model_dir.iterdir() if path.is_dir()):
            report_path = instance_dir / "report.json"
            if not report_path.exists():
                continue
            report = json.loads(report_path.read_text(encoding="utf-8"))
            instance_id = instance_dir.name
            resolved = bool(report.get(instance_id, {}).get("resolved", False))
            rows.append(
                {
                    "instance_id": instance_id,
                    "model_name_or_path": model_dir.name,
                    "resolved": resolved,
                }
            )

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")

    print(f"Wrote {len(rows)} evaluation rows to {output_path}")


if __name__ == "__main__":
    main()
