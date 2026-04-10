import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tasks", required=True)
    parser.add_argument("--predictions", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    tasks = {row["instanceId"]: row for row in read_jsonl(Path(args.tasks))}
    predictions = read_jsonl(Path(args.predictions))
    rows = []

    for prediction in predictions:
        instance_id = prediction["instance_id"]
        task = tasks.get(instance_id)
        if not task:
            raise SystemExit(f"Task not found for prediction: {instance_id}")

        resolved, details = verify_prediction(task, prediction["model_patch"])
        rows.append(
            {
                "instance_id": instance_id,
                "model_name_or_path": prediction["model_name_or_path"],
                "resolved": resolved,
                "details": details,
            }
        )

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")

    print(f"Wrote {len(rows)} local verification rows to {output_path}")


def verify_prediction(task, patch_text):
    workspace_path = task.get("workspacePath")
    base_commit = task.get("baseCommit")
    verify_commands = task.get("verifyCommands") or []
    test_patch = task.get("testPatch")

    if not workspace_path:
        return False, "workspacePath is required for local verification"
    if not base_commit:
        return False, "baseCommit is required for local verification"
    if not verify_commands:
        return False, "verifyCommands are required for local verification"
    if not patch_text.strip():
        return False, "prediction patch is empty"

    repo_path = Path(workspace_path)
    temp_dir = Path(tempfile.mkdtemp(prefix=f"verify-{task['instanceId']}-"))
    outputs = []

    try:
        run(["git", "-C", str(repo_path), "worktree", "add", "--detach", str(temp_dir), base_commit])

        patch_path = temp_dir / "prediction.patch"
        patch_path.write_text(patch_text, encoding="utf-8", newline="\n")
        apply_result = subprocess.run(
            ["git", "apply", "--whitespace=nowarn", str(patch_path)],
            cwd=temp_dir,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        outputs.append(
            {
                "command": f"git apply --whitespace=nowarn {patch_path.name}",
                "returncode": apply_result.returncode,
                "output": apply_result.stdout,
            }
        )
        if apply_result.returncode != 0:
            return False, json.dumps(outputs)

        if test_patch:
            test_patch_path = temp_dir / "task-test.patch"
            test_patch_path.write_text(test_patch, encoding="utf-8", newline="\n")
            test_patch_result = subprocess.run(
                ["git", "apply", "--whitespace=nowarn", str(test_patch_path)],
                cwd=temp_dir,
                text=True,
                encoding="utf-8",
                errors="replace",
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                check=False,
            )
            outputs.append(
                {
                    "command": f"git apply --whitespace=nowarn {test_patch_path.name}",
                    "returncode": test_patch_result.returncode,
                    "output": test_patch_result.stdout,
                }
            )
            if test_patch_result.returncode != 0:
                return False, json.dumps(outputs)

        for command in verify_commands:
            result = subprocess.run(
                command,
                cwd=temp_dir,
                shell=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                check=False,
            )
            outputs.append({"command": command, "returncode": result.returncode, "output": result.stdout})
            if result.returncode != 0:
                return False, json.dumps(outputs)

        return True, json.dumps(outputs)
    finally:
        subprocess.run(
            ["git", "-C", str(repo_path), "worktree", "remove", "--force", str(temp_dir)],
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        shutil.rmtree(temp_dir, ignore_errors=True)


def read_jsonl(path):
    rows = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def run(args):
    result = subprocess.run(
        args,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stdout)
    return result


if __name__ == "__main__":
    main()
