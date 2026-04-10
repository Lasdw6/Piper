param(
  [string]$Dataset = "princeton-nlp/SWE-bench_Lite",
  [string]$Split = "dev",
  [string]$Tag = "latest",
  [int]$MaxWorkers = 1
)

$instanceIds = @(
  "sqlfluff__sqlfluff-1625",
  "marshmallow-code__marshmallow-1359",
  "pylint-dev__astroid-1978",
  "pydicom__pydicom-1694"
)

$repoPath = (Resolve-Path ".").Path
$wslRepoPath = "/mnt/" + $repoPath.Substring(0,1).ToLower() + $repoPath.Substring(2).Replace("\","/")
$instanceArg = ($instanceIds -join " ")

$command = @"
set -e
cd '$wslRepoPath'
python3 -m pip install swebench >/dev/null
python3 '$wslRepoPath/src/prepare_swebench_tasks.py' \
  --dataset '$Dataset' \
  --split '$Split' \
  --output '$wslRepoPath/data/swebench-lite-dev4-docker.tasks.jsonl' \
  --workspace-root '$wslRepoPath/workspaces/swebench-lite-dev4-docker-placeholder' \
  --docker-backed \
  --docker-tag '$Tag' \
  --instance-id sqlfluff__sqlfluff-1625 \
  --instance-id marshmallow-code__marshmallow-1359 \
  --instance-id pylint-dev__astroid-1978 \
  --instance-id pydicom__pydicom-1694
python3 -m swebench.harness.prepare_images \
  --dataset_name '$Dataset' \
  --split '$Split' \
  --instance_ids $instanceArg \
  --max_workers $MaxWorkers \
  --tag '$Tag'
"@

wsl bash -lc $command
