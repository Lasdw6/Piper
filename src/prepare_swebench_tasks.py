import argparse
import json
import subprocess
from pathlib import Path

from datasets import load_dataset


DEFAULT_INSTANCE_IDS = [
    "marshmallow-code__marshmallow-1359",
    "pydicom__pydicom-1694",
    "pylint-dev__astroid-1978",
    "sqlfluff__sqlfluff-1625",
]
DEFAULT_WORKING_DIRECTORY = "/testbed"
DEFAULT_IMAGE_TAG = "latest"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="princeton-nlp/SWE-bench_Lite")
    parser.add_argument("--split", default="dev")
    parser.add_argument("--output", required=True)
    parser.add_argument("--workspace-root", required=True)
    parser.add_argument("--instance-id", action="append", dest="instance_ids")
    parser.add_argument("--clone", action="store_true")
    parser.add_argument("--docker-backed", action="store_true")
    parser.add_argument("--docker-tag", default=DEFAULT_IMAGE_TAG)
    parser.add_argument("--working-directory", default=DEFAULT_WORKING_DIRECTORY)
    args = parser.parse_args()

    rows = load_dataset(args.dataset, split=args.split)
    wanted_ids = args.instance_ids or DEFAULT_INSTANCE_IDS
    selected = [row for row in rows if row["instance_id"] in set(wanted_ids)]
    if len(selected) != len(wanted_ids):
        missing = sorted(set(wanted_ids) - {row["instance_id"] for row in selected})
        raise SystemExit(f"Missing instance ids from dataset: {missing}")

    output_path = Path(args.output)
    workspace_root = Path(args.workspace_root)
    workspace_root.mkdir(parents=True, exist_ok=True)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    task_rows = []
    for row in selected:
        repo_slug = row["repo"].replace("/", "__")
        workspace_path = workspace_root / repo_slug
        if args.clone and not args.docker_backed:
            prepare_repo(row["repo"], row["base_commit"], workspace_path)

        task_row = {
            "instanceId": row["instance_id"],
            "repo": row["repo"],
            "problemStatement": row["problem_statement"],
            "baseCommit": row["base_commit"],
            "hints": [row["hints_text"]] if row.get("hints_text") else [],
            "metadata": {
                "dataset": args.dataset,
                "split": args.split,
                "environment_setup_commit": row.get("environment_setup_commit"),
                "version": row.get("version"),
            },
        }

        if args.docker_backed:
            task_row["dockerImage"] = f"sweb.eval.x86_64.{row['instance_id'].lower()}:{args.docker_tag}"
            task_row["workingDirectory"] = args.working_directory
        else:
            task_row["workspacePath"] = str(workspace_path)

        task_rows.append(task_row)

    with output_path.open("w", encoding="utf-8") as handle:
        for row in task_rows:
            handle.write(json.dumps(row) + "\n")

    print(f"Wrote {len(task_rows)} tasks to {output_path}")


def prepare_repo(repo: str, base_commit: str, workspace_path: Path):
    remote = f"https://github.com/{repo}.git"
    if not workspace_path.exists():
        run(["git", "clone", remote, str(workspace_path)])
    run(["git", "-C", str(workspace_path), "fetch", "--all", "--tags"])
    run(["git", "-C", str(workspace_path), "checkout", "--force", base_commit])
    run(["git", "-C", str(workspace_path), "clean", "-fd"])


def run(command: list[str]):
    completed = subprocess.run(command, check=True, text=True, capture_output=True)
    return completed.stdout


if __name__ == "__main__":
    main()
