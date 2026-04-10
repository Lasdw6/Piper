import argparse
import gzip
import json
import pathlib
import urllib.request


SOURCE_URL = "https://github.com/openai/human-eval/raw/master/data/HumanEval.jsonl.gz"


def load_records(cache_path: pathlib.Path):
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    if not cache_path.exists():
      urllib.request.urlretrieve(SOURCE_URL, cache_path)

    with gzip.open(cache_path, "rt", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--cache", default="data/HumanEval.jsonl.gz")
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--offset", type=int, default=0)
    args = parser.parse_args()

    output_path = pathlib.Path(args.output)
    cache_path = pathlib.Path(args.cache)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    records = list(load_records(cache_path))
    sliced = records[args.offset : args.offset + args.limit]

    with output_path.open("w", encoding="utf-8") as handle:
        for record in sliced:
            task = {
                "instanceId": record["task_id"].replace("/", "_"),
                "repo": "humaneval",
                "problemStatement": f"Solve {record['task_id']}",
                "metadata": {
                    "taskId": record["task_id"],
                    "prompt": record["prompt"],
                    "test": record["test"],
                    "entryPoint": record["entry_point"],
                },
            }
            handle.write(json.dumps(task) + "\n")


if __name__ == "__main__":
    main()
