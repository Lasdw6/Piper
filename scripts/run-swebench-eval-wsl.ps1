param(
  [Parameter(Mandatory = $true)][string]$PredictionsPath,
  [Parameter(Mandatory = $true)][string]$RunId,
  [string]$Dataset = "princeton-nlp/SWE-bench_Lite",
  [string]$Split = "dev",
  [string]$InstanceIds = "",
  [int]$MaxWorkers = 1,
  [int]$Timeout = 1800
)

$ErrorActionPreference = "Stop"

$repoPath = (Resolve-Path ".").Path
$wslRepoPath = "/mnt/" + $repoPath.Substring(0,1).ToLower() + $repoPath.Substring(2).Replace("\","/")
$wslPredictionsPath = "/mnt/" + (Resolve-Path $PredictionsPath).Path.Substring(0,1).ToLower() + (Resolve-Path $PredictionsPath).Path.Substring(2).Replace("\","/")

$instanceArg = ""
if ($InstanceIds) {
  $instanceArg = "--instance_ids $InstanceIds"
}

$command = @"
set -e
cd '$wslRepoPath'
if ! python3 -m pip --version >/dev/null 2>&1; then
  curl -fsSL https://bootstrap.pypa.io/get-pip.py -o /tmp/get-pip.py
  python3 /tmp/get-pip.py --user >/dev/null
fi
python3 -m pip install --user swebench >/dev/null
python3 -m swebench.harness.run_evaluation \
  --dataset_name '$Dataset' \
  --split '$Split' \
  --predictions_path '$wslPredictionsPath' \
  --max_workers $MaxWorkers \
  --timeout $Timeout \
  --run_id '$RunId' \
  $instanceArg
"@

wsl bash -lc $command
