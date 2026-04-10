import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import type {
  AgentAdapter,
  AgentRunArtifacts,
  AgentRunContext,
  AgentRunResult,
  BenchmarkTask,
  BenchmarkVariant
} from "./benchmark-types.js";

export class CommandAgentAdapter implements AgentAdapter {
  readonly name: string;

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
    name = "command-agent"
  ) {
    this.name = name;
  }

  async runTask(task: BenchmarkTask, variant: BenchmarkVariant, context?: AgentRunContext): Promise<AgentRunResult> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "piper-bench-"));
    const artifactDir = context?.artifactDir ? path.resolve(context.artifactDir) : undefined;
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
    }
    const taskPath = artifactDir ? path.join(artifactDir, "task.json") : path.join(tempDir, "task.json");
    const resultPath = artifactDir ? path.join(artifactDir, "result.raw.json") : path.join(tempDir, "result.json");
    const artifacts = buildArtifactPaths(artifactDir);

    try {
      await writeFile(taskPath, `${JSON.stringify({ task, variant }, null, 2)}\n`, "utf8");

      await runCommand(this.command, this.args, {
        BENCHMARK_TASK_PATH: taskPath,
        BENCHMARK_RESULT_PATH: resultPath,
        BENCHMARK_VARIANT_ID: variant.id
      });

      const rawResult = await readFile(resultPath, "utf8");
      const result = JSON.parse(rawResult) as AgentRunResult;
      const mergedArtifacts = artifacts
        ? {
            ...artifacts,
            ...(result.artifacts ?? {})
          }
        : result.artifacts;
      return {
        ...result,
        ...(mergedArtifacts ? { artifacts: mergedArtifacts } : {})
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

function runCommand(command: string, args: string[], extraEnv: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: true,
      env: {
        ...process.env,
        ...extraEnv
      }
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Agent command failed with exit code ${code ?? -1}.`));
    });
    child.on("error", reject);
  });
}

function buildArtifactPaths(artifactDir?: string): AgentRunArtifacts | undefined {
  if (!artifactDir) {
    return undefined;
  }

  return {
    runDir: artifactDir,
    payloadPath: path.join(artifactDir, "task.json"),
    rawResultPath: path.join(artifactDir, "result.raw.json")
  };
}
