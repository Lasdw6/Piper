import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

interface MiniSweAgentAdapterOptions {
  pythonExecutable?: string;
  bridgePath?: string;
  timeoutMs?: number;
}

export class MiniSweAgentAdapter implements AgentAdapter {
  readonly name = "mini-swe-agent";
  private readonly pythonExecutable: string;
  private readonly bridgePath: string;
  private readonly timeoutMs: number | undefined;

  constructor(options: MiniSweAgentAdapterOptions = {}) {
    this.pythonExecutable = options.pythonExecutable ?? "python";
    this.bridgePath = options.bridgePath ?? path.join(process.cwd(), "src", "algorithm", "mini_swe_agent_bridge.py");
    this.timeoutMs = options.timeoutMs;
  }

  async runTask(task: BenchmarkTask, variant: BenchmarkVariant, context?: AgentRunContext): Promise<AgentRunResult> {
    if (!task.workspacePath && !task.dockerImage) {
      throw new Error("mini-swe-agent tasks require either workspacePath for local runs or dockerImage for container runs.");
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "piper-mini-swe-"));
    const artifactDir = context?.artifactDir ? path.resolve(context.artifactDir) : undefined;
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
    }
    const payloadPath = artifactDir ? path.join(artifactDir, "payload.json") : path.join(tempDir, "payload.json");
    const resultPath = artifactDir ? path.join(artifactDir, "result.raw.json") : path.join(tempDir, "result.json");
    const prepared = await prepareTaskWorkspace(task, tempDir);
    const artifacts = buildArtifactPaths(artifactDir);

    try {
      await writeFile(payloadPath, `${JSON.stringify({ task: prepared.task, variant }, null, 2)}\n`, "utf8");
      try {
        await runPython(this.pythonExecutable, this.bridgePath, payloadPath, resultPath, artifactDir, this.timeoutMs);
      } catch (error) {
        if (!(await fileExists(resultPath))) {
          const message = error instanceof Error ? error.message : String(error);
          const recovered = artifactDir ? await recoverResultFromArtifacts(artifactDir, message) : null;
          if (recovered) {
            await writeFile(resultPath, `${JSON.stringify(recovered, null, 2)}\n`, "utf8");
          } else {
          if (artifactDir) {
            await writeFile(path.join(artifactDir, "error.json"), `${JSON.stringify({ error: message }, null, 2)}\n`, "utf8");
          }
          const synthetic: AgentRunResult = {
            patch: "",
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0
            },
            turnUsages: [],
            summary: message,
            metadata: {
              run_error: message
            },
            ...(artifacts ? { artifacts } : {})
          };
          await writeFile(resultPath, `${JSON.stringify(synthetic, null, 2)}\n`, "utf8");
          }
        }
      }
      const result = JSON.parse(await readFile(resultPath, "utf8")) as AgentRunResult;
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
      await prepared.cleanup();
      await removeDirectoryWithRetry(tempDir);
    }
  }
}

async function recoverResultFromArtifacts(artifactDir: string, fallbackMessage: string): Promise<AgentRunResult | null> {
  const serializedPath = path.join(artifactDir, "serialized.json");
  if (!(await fileExists(serializedPath))) {
    return null;
  }

  try {
    const serialized = JSON.parse(await readFile(serializedPath, "utf8")) as {
      messages?: Array<Record<string, unknown>>;
      info?: Record<string, unknown>;
    };
    const compressionDebugPath = path.join(artifactDir, "compression-debug.json");
    const compressionDebug = (await fileExists(compressionDebugPath))
      ? (JSON.parse(await readFile(compressionDebugPath, "utf8")) as {
          summaryTurns?: Array<Record<string, unknown>>;
          compressionStats?: Record<string, unknown>;
        })
      : undefined;

    const usage = extractUsage(serialized.messages ?? []);
    const summaryUsage = extractSummaryUsage(compressionDebug?.summaryTurns ?? []);
    const merged = mergeUsage(usage, summaryUsage);
    const info = serialized.info ?? {};
    const modelStats = objectValue(info, "model_stats");
    const compressionStats = compressionDebug?.compressionStats;
    const metadata: Record<string, string | number | boolean | null> = {
      compression_wrapper_enabled: Boolean(compressionStats),
      mini_swe_agent_cost: numberValue(modelStats, "instance_cost"),
      mini_swe_agent_api_calls: numberValue(modelStats, "api_calls"),
      submission_exit_status: stringValue(info, "exit_status") || fallbackMessage,
      recovered_after_error: fallbackMessage,
    };

    if (compressionStats) {
      metadata.compression = JSON.stringify(compressionStats);
    }

    const recovered: AgentRunResult = {
      patch: "",
      usage: merged.totals,
      turnUsages: merged.turns,
      summary: stringValue(info, "exit_status") || fallbackMessage,
      metadata,
    };
    const artifacts = buildArtifactPaths(artifactDir);
    if (artifacts) {
      recovered.artifacts = artifacts;
    }
    return recovered;
  } catch {
    return null;
  }
}

async function fileExists(filename: string): Promise<boolean> {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

async function prepareTaskWorkspace(
  task: BenchmarkTask,
  tempDir: string
): Promise<{ task: BenchmarkTask; cleanup: () => Promise<void> }> {
  if (!task.workspacePath) {
    return {
      task,
      cleanup: async () => {}
    };
  }

  const sourceWorkspace = path.resolve(task.workspacePath);
  const worktreePath = path.join(tempDir, "worktree");
  const reference = task.baseCommit ?? "HEAD";
  await runProcess("git", ["-C", sourceWorkspace, "worktree", "add", "--detach", worktreePath, reference]);
  await rewriteWorktreeGitFileForWsl(worktreePath);

  return {
    task: {
      ...task,
      workspacePath: worktreePath
    },
    cleanup: async () => {
      await removeWorktreeWithRetry(sourceWorkspace, worktreePath);
    }
  };
}

function runPython(
  pythonExecutable: string,
  bridgePath: string,
  payloadPath: string,
  resultPath: string,
  artifactDir?: string,
  timeoutMs?: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let settled = false;
    const child = spawn(
      pythonExecutable,
      [
        bridgePath,
        "--payload",
        payloadPath,
        "--result",
        resultPath,
        ...(artifactDir ? ["--artifact-dir", artifactDir] : [])
      ],
      {
        stdio: "pipe",
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          MSWEA_SILENT_STARTUP: "1"
        }
      }
    );

    const timeout = timeoutMs
      ? setTimeout(() => {
          settled = true;
          if (process.platform === "win32") {
            void spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
              stdio: "ignore",
              windowsHide: true
            });
          } else {
            child.kill("SIGKILL");
          }
          void persistProcessLogs(artifactDir, stdoutChunks.join(""), stderrChunks.join(""))
            .catch(() => undefined)
            .finally(() => reject(new Error(`mini-swe-agent bridge timed out after ${timeoutMs}ms.`)));
        }, timeoutMs)
      : undefined;

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdoutChunks.push(text);
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderrChunks.push(text);
      process.stderr.write(text);
    });

    child.on("exit", (code) => {
      if (settled) {
        return;
      }
      if (timeout) {
        clearTimeout(timeout);
      }

      void persistProcessLogs(artifactDir, stdoutChunks.join(""), stderrChunks.join(""))
        .catch(() => undefined)
        .finally(() => {
          if (code === 0) {
            resolve();
            return;
          }

          reject(new Error(`mini-swe-agent bridge failed with exit code ${code ?? -1}.`));
        });
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      if (timeout) {
        clearTimeout(timeout);
      }
      void persistProcessLogs(artifactDir, stdoutChunks.join(""), stderrChunks.join(""))
        .catch(() => undefined)
        .finally(() => reject(error));
    });
  });
}

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "pipe",
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8"
      }
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? -1}\n${stdout}${stderr}`.trim()));
    });
    child.on("error", reject);
  });
}

async function removeWorktreeWithRetry(sourceWorkspace: string, worktreePath: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await runProcess("git", ["-C", sourceWorkspace, "worktree", "remove", "--force", worktreePath]);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("EBUSY") || attempt === 3) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
}

async function removeDirectoryWithRetry(targetPath: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("EBUSY") || attempt === 4) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
    }
  }
}

function extractUsage(messages: Array<Record<string, unknown>>) {
  const turns: AgentRunResult["turnUsages"] = [];
  const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] ?? {};
    const extra = objectValue(message, "extra");
    const response = objectValue(extra, "response");
    const usage = objectValue(response, "usage");
    const inputTokens = firstInt(usage, "prompt_tokens", "input_tokens", "promptTokens", "inputTokens");
    const outputTokens = firstInt(usage, "completion_tokens", "output_tokens", "completionTokens", "outputTokens");
    const totalTokens = firstInt(usage, "total_tokens", "totalTokens") || inputTokens + outputTokens;
    if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) {
      continue;
    }
    turns.push({
      turnId: stringValue(response, "id") || `turn_${index}`,
      phaseId: `call_${turns.length + 1}`,
      model: stringValue(response, "model") || stringValue(response, "model_name"),
      kind: "response",
      inputTokens,
      outputTokens,
      totalTokens,
    });
    totals.inputTokens += inputTokens;
    totals.outputTokens += outputTokens;
    totals.totalTokens += totalTokens;
  }
  return { turns, totals };
}

function extractSummaryUsage(turns: Array<Record<string, unknown>>) {
  const normalized = turns.flatMap((turn, index) => {
    const inputTokens = firstInt(turn, "inputTokens");
    const outputTokens = firstInt(turn, "outputTokens");
    const totalTokens = firstInt(turn, "totalTokens") || inputTokens + outputTokens;
    if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) {
      return [];
    }
    return [
      {
        turnId: stringValue(turn, "turnId") || `summary_${index + 1}`,
        phaseId: stringValue(turn, "phaseId") || "compression",
        model: stringValue(turn, "model"),
        kind: "summary" as const,
        inputTokens,
        outputTokens,
        totalTokens,
      },
    ];
  });
  return {
    turns: normalized,
    totals: {
      inputTokens: normalized.reduce((sum, turn) => sum + turn.inputTokens, 0),
      outputTokens: normalized.reduce((sum, turn) => sum + turn.outputTokens, 0),
      totalTokens: normalized.reduce((sum, turn) => sum + turn.totalTokens, 0),
    },
  };
}

function mergeUsage(
  primary: { turns: NonNullable<AgentRunResult["turnUsages"]>; totals: AgentRunResult["usage"] },
  secondary: { turns: NonNullable<AgentRunResult["turnUsages"]>; totals: AgentRunResult["usage"] }
) {
  return {
    turns: [...primary.turns, ...secondary.turns],
    totals: {
      inputTokens: primary.totals.inputTokens + secondary.totals.inputTokens,
      outputTokens: primary.totals.outputTokens + secondary.totals.outputTokens,
      totalTokens: primary.totals.totalTokens + secondary.totals.totalTokens,
    },
  };
}

function objectValue(record: unknown, key: string): Record<string, unknown> {
  if (!record || typeof record !== "object") {
    return {};
  }
  const value = (record as Record<string, unknown>)[key];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(record: unknown, key: string): string {
  if (!record || typeof record !== "object") {
    return "";
  }
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function numberValue(record: unknown, key: string): number {
  if (!record || typeof record !== "object") {
    return 0;
  }
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "number" ? value : 0;
}

function firstInt(record: unknown, ...keys: string[]): number {
  if (!record || typeof record !== "object") {
    return 0;
  }
  for (const key of keys) {
    const value = (record as Record<string, unknown>)[key];
    if (typeof value === "number") {
      return Math.trunc(value);
    }
  }
  return 0;
}

async function rewriteWorktreeGitFileForWsl(worktreePath: string): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }

  const gitFilePath = path.join(worktreePath, ".git");
  try {
    const original = await readFile(gitFilePath, "utf8");
    const rewritten = original.replace(/^gitdir:\s+(.+)$/m, (_match, rawPath: string) => {
      const trimmed = String(rawPath).trim();
      if (/^[A-Za-z]:[\\/]/.test(trimmed) || /^[A-Za-z]:\//.test(trimmed)) {
        return `gitdir: ${toWslPath(trimmed)}`;
      }
      return `gitdir: ${trimmed}`;
    });
    if (rewritten !== original) {
      await writeFile(gitFilePath, rewritten, "utf8");
    }
  } catch {
    // Ignore if the worktree uses a directory-based .git layout.
  }
}

function toWslPath(winPath: string): string {
  const normalizedInput = winPath.replace(/\\/g, "/");
  const normalized = /^[A-Za-z]:\//.test(normalizedInput)
    ? normalizedInput
    : path.resolve(winPath).replace(/\\/g, "/");
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!match) {
    return normalized;
  }
  const drive = match[1]?.toLowerCase();
  const rest = match[2] ?? "";
  return `/mnt/${drive}/${rest}`;
}

function buildArtifactPaths(artifactDir?: string): AgentRunArtifacts | undefined {
  if (!artifactDir) {
    return undefined;
  }

  return {
    runDir: artifactDir,
    payloadPath: path.join(artifactDir, "payload.json"),
    rawResultPath: path.join(artifactDir, "result.raw.json"),
    stdoutPath: path.join(artifactDir, "stdout.log"),
    stderrPath: path.join(artifactDir, "stderr.log"),
    trajectoryPath: path.join(artifactDir, "trajectory.json"),
    serializedPath: path.join(artifactDir, "serialized.json"),
    compressionDebugPath: path.join(artifactDir, "compression-debug.json"),
    errorPath: path.join(artifactDir, "error.json")
  };
}

async function persistProcessLogs(artifactDir: string | undefined, stdout: string, stderr: string): Promise<void> {
  if (!artifactDir) {
    return;
  }

  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, "stdout.log"), stdout, "utf8");
  await writeFile(path.join(artifactDir, "stderr.log"), stderr, "utf8");
}
