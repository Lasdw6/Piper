import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { VercelAICompressionRuntime } from "./vercel-ai-runtime.js";
import type { AgentRunResult, BenchmarkTask, BenchmarkVariant } from "./harness/benchmark-types.js";

interface Payload {
  task: BenchmarkTask;
  variant: BenchmarkVariant;
}

interface AppsMetadata {
  taskId: string;
  question: string;
  starterCode: string;
  inputOutput: {
    inputs: unknown[];
    outputs: unknown[];
    fn_name?: string | null;
  };
  difficulty?: string;
  url?: string;
}

interface AttemptRecord {
  attempt: number;
  solutionPath: string;
  success: boolean;
  exitCode: number | null;
  failedTestIndex: number | null;
  failureKind: string | null;
  stdout: string;
  stderr: string;
  expected?: string;
  actual?: string;
  input?: string;
}

const MAX_ATTEMPTS = Number(process.env.APPS_MAX_ATTEMPTS ?? "5");
const RESPONSE_MAX_TOKENS = Number(process.env.APPS_RESPONSE_MAX_TOKENS ?? "2600");
const TEST_TIMEOUT_MS = Number(process.env.APPS_TEST_TIMEOUT_MS ?? "8000");
const FAILURE_SUMMARY_CHARS = Number(process.env.APPS_FAILURE_SUMMARY_CHARS ?? "2500");

async function main(): Promise<void> {
  process.loadEnvFile?.();
  const taskPath = process.env.BENCHMARK_TASK_PATH;
  const resultPath = process.env.BENCHMARK_RESULT_PATH;
  if (!taskPath || !resultPath) {
    throw new Error("BENCHMARK_TASK_PATH and BENCHMARK_RESULT_PATH are required.");
  }

  const payload = JSON.parse(await readFile(taskPath, "utf8")) as Payload;
  const metadata = parseMetadata(payload.task);
  const artifactDir = path.dirname(resultPath);
  await mkdir(artifactDir, { recursive: true });
  requiredEnv("OPENAI_API_KEY");

  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "apps-agent-"));
  const attempts: AttemptRecord[] = [];
  let resolved = false;
  let finalCode = "";
  let finalFailure = "";
  let compressionActivated = false;
  let compressionTurnCount = 0;

  try {
    const systemPrompt = buildSystemPrompt(metadata);
    const runtime = createRuntime(payload.variant, artifactDir, systemPrompt);

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const userPrompt = buildAttemptPrompt(attempt, finalFailure);
        const response = await runtime.respond(userPrompt, {
          phaseId: `attempt_${attempt}`,
          tags: [metadata.taskId],
          retrievalQuery: `${metadata.taskId.replaceAll("/", " ")} ${metadata.question.slice(0, 400)}`
        });
        const compressedThisTurn =
          response.snapshot.items.some((item) => item.kind !== "raw") ||
          response.snapshot.archivedKeys.length > 0 ||
          response.retrievedContext.length > 0;
        if (compressedThisTurn) {
          compressionActivated = true;
          compressionTurnCount += 1;
        }
        const code = normalizeCode(response.text);
        finalCode = code;

        const attemptResult = await executeAppsTests(workspaceDir, metadata, code, attempt);
        attempts.push(attemptResult);
        finalFailure = truncateFailure(attemptResult);

        if (attemptResult.success) {
          resolved = true;
          break;
        }
      }

      const usage = runtime.getUsage();
      await persistArtifacts(artifactDir, attempts, metadata, finalCode);
      await writeResult(resultPath, {
        patch: finalCode,
        resolved,
        usage: usage.totals,
        turnUsages: usage.turns,
        summary: resolved ? "APPS task passed." : "APPS task failed.",
        metadata: buildMetadata(
          metadata,
          attempts,
          resolved,
          compressionActivated,
          compressionTurnCount,
          usage.turns.some((turn) => turn.kind === "summary")
        )
      });
    } finally {
      runtime.close();
    }
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

function parseMetadata(task: BenchmarkTask): AppsMetadata {
  const metadata = task.metadata as Record<string, unknown> | undefined;
  const question = typeof metadata?.question === "string" ? metadata.question : "";
  const starterCode = typeof metadata?.starterCode === "string" ? metadata.starterCode : "";
  const inputOutputRaw = typeof metadata?.inputOutput === "string" ? metadata.inputOutput : "";
  if (!question || !inputOutputRaw) {
    throw new Error(`Task ${task.instanceId} is missing APPS metadata.`);
  }

  const inputOutput = JSON.parse(inputOutputRaw) as AppsMetadata["inputOutput"];
  const parsed: AppsMetadata = {
    taskId: typeof metadata?.appsId === "number" ? `APPS/${metadata.appsId}` : task.instanceId,
    question,
    starterCode,
    inputOutput
  };
  if (typeof metadata?.difficulty === "string") {
    parsed.difficulty = metadata.difficulty;
  }
  if (typeof metadata?.url === "string") {
    parsed.url = metadata.url;
  }
  return parsed;
}

function buildSystemPrompt(metadata: AppsMetadata): string {
  const parts = [
    "You solve APPS Python programming tasks.",
    "Return only raw Python code.",
    "Do not use markdown fences.",
    "Do not explain your answer.",
    "Produce a complete Python 3 solution that passes all hidden tests.",
    "Read from standard input and write to standard output unless starter code clearly defines another interface.",
    `Task ID: ${metadata.taskId}`,
    metadata.difficulty ? `Difficulty: ${metadata.difficulty}` : "",
    metadata.url ? `Source: ${metadata.url}` : "",
    "",
    "Problem:",
    metadata.question
  ];

  if (metadata.starterCode.trim()) {
    parts.push("", "Starter code:", metadata.starterCode);
  }

  return parts.filter(Boolean).join("\n");
}

function buildAttemptPrompt(attempt: number, previousFailure: string): string {
  if (attempt === 1) {
    return "Write the complete Python solution now.";
  }

  return [
    "Previous attempt failed.",
    "Return a revised complete Python solution only.",
    "Failure summary:",
    previousFailure
  ].join("\n");
}

async function executeAppsTests(
  workspaceDir: string,
  metadata: AppsMetadata,
  code: string,
  attempt: number
): Promise<AttemptRecord> {
  const solutionPath = path.join(workspaceDir, `solution_${attempt}.py`);
  await writeFile(solutionPath, code, "utf8");

  const inputs = metadata.inputOutput.inputs ?? [];
  const outputs = metadata.inputOutput.outputs ?? [];
  const testCount = Math.min(inputs.length, outputs.length);

  for (let index = 0; index < testCount; index += 1) {
    const execution = await runPythonWithInput(solutionPath, toInputString(inputs[index]), TEST_TIMEOUT_MS);
    if (execution.timeout) {
      return {
        attempt,
        solutionPath,
        success: false,
        exitCode: execution.exitCode,
        failedTestIndex: index,
        failureKind: "timeout",
        stdout: execution.stdout,
        stderr: execution.stderr,
        expected: renderExpected(outputs[index]),
        actual: execution.stdout,
        input: toInputString(inputs[index])
      };
    }
    if (execution.exitCode !== 0) {
      return {
        attempt,
        solutionPath,
        success: false,
        exitCode: execution.exitCode,
        failedTestIndex: index,
        failureKind: "runtime_error",
        stdout: execution.stdout,
        stderr: execution.stderr,
        expected: renderExpected(outputs[index]),
        actual: execution.stdout,
        input: toInputString(inputs[index])
      };
    }

    if (!outputsMatch(execution.stdout, outputs[index])) {
      return {
        attempt,
        solutionPath,
        success: false,
        exitCode: execution.exitCode,
        failedTestIndex: index,
        failureKind: "wrong_answer",
        stdout: execution.stdout,
        stderr: execution.stderr,
        expected: renderExpected(outputs[index]),
        actual: execution.stdout,
        input: toInputString(inputs[index])
      };
    }
  }

  return {
    attempt,
    solutionPath,
    success: true,
    exitCode: 0,
    failedTestIndex: null,
    failureKind: null,
    stdout: "",
    stderr: ""
  };
}

function runPythonWithInput(
  scriptPath: string,
  stdinText: string,
  timeoutMs: number
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timeout: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("python", [scriptPath], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timeout: timedOut });
    });

    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

function outputsMatch(actual: string, expected: unknown): boolean {
  const actualForms = candidateOutputForms(actual);
  for (const candidate of expectedCandidates(expected)) {
    const expectedForms = candidateOutputForms(candidate);
    for (const actualForm of actualForms) {
      if (expectedForms.has(actualForm)) {
        return true;
      }
    }

    const actualTokens = tokenizeOutput(actual);
    const expectedTokens = tokenizeOutput(candidate);
    if (actualTokens.length === expectedTokens.length && actualTokens.length > 0) {
      let allEqual = true;
      for (let index = 0; index < actualTokens.length; index += 1) {
        if (!tokensEquivalent(actualTokens[index] ?? "", expectedTokens[index] ?? "")) {
          allEqual = false;
          break;
        }
      }
      if (allEqual) {
        return true;
      }
    }
  }

  return false;
}

function expectedCandidates(expected: unknown): string[] {
  if (typeof expected === "string") {
    return [expected];
  }
  if (Array.isArray(expected)) {
    if (expected.every((item) => typeof item === "string")) {
      return [expected.join("\n")];
    }
    return [JSON.stringify(expected), expected.map((item) => stringifyScalar(item)).join("\n")];
  }
  return [stringifyScalar(expected)];
}

function candidateOutputForms(value: string): Set<string> {
  const normalized = normalizeOutput(value);
  return new Set([normalized, normalized.replace(/\s+/g, " ").trim()]);
}

function tokenizeOutput(value: string): string[] {
  return normalizeOutput(value).split(/\s+/).filter(Boolean);
}

function tokensEquivalent(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return Math.abs(leftNumber - rightNumber) <= 1e-6;
  }

  return false;
}

function normalizeOutput(value: string): string {
  return value.replace(/\r\n/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();
}

function normalizeCode(text: string): string {
  let value = text.replace(/\r\n/g, "\n");
  if (value.trimStart().startsWith("```")) {
    value = value.trimStart().replace(/^```[a-zA-Z]*\s*/, "");
    value = value.replace(/\s*```[\t ]*$/m, "");
  }
  return value.trimEnd();
}

function toInputString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return `${value.map((item) => stringifyScalar(item)).join("\n")}\n`;
  }
  return `${stringifyScalar(value)}\n`;
}

function renderExpected(value: unknown): string {
  return expectedCandidates(value)[0] ?? "";
}

function stringifyScalar(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return "";
  }
  return JSON.stringify(value);
}

function truncateFailure(attempt: AttemptRecord): string {
  const parts = [
    attempt.failureKind ? `Failure: ${attempt.failureKind}` : "",
    attempt.failedTestIndex !== null ? `Test index: ${attempt.failedTestIndex}` : "",
    attempt.input ? `Input:\n${attempt.input}` : "",
    attempt.expected ? `Expected:\n${attempt.expected}` : "",
    attempt.actual ? `Actual:\n${attempt.actual}` : "",
    attempt.stderr ? `Stderr:\n${attempt.stderr}` : "",
    attempt.stdout && !attempt.actual ? `Stdout:\n${attempt.stdout}` : ""
  ].filter(Boolean);
  const detail = parts.join("\n\n");
  return detail.length > FAILURE_SUMMARY_CHARS ? `${detail.slice(0, FAILURE_SUMMARY_CHARS)}...` : detail;
}

async function persistArtifacts(
  artifactDir: string,
  attempts: AttemptRecord[],
  metadata: AppsMetadata,
  finalCode: string
): Promise<void> {
  await writeFile(path.join(artifactDir, "attempts.json"), JSON.stringify(attempts, null, 2), "utf8");
  await writeFile(path.join(artifactDir, "problem.txt"), metadata.question, "utf8");
  await writeFile(path.join(artifactDir, "final_solution.py"), finalCode, "utf8");
}

function buildMetadata(
  metadata: AppsMetadata,
  attempts: AttemptRecord[],
  resolved: boolean,
  compressionActivated: boolean,
  compressionTurnCount: number,
  summaryActivated: boolean
): Record<string, string | number | boolean | null> {
  const last = attempts.at(-1);
  return {
    benchmark: "apps",
    taskId: metadata.taskId,
    difficulty: metadata.difficulty ?? null,
    attempts: attempts.length,
    testCount: Math.min(metadata.inputOutput.inputs.length, metadata.inputOutput.outputs.length),
    compressionActivated,
    compressionTurnCount,
    summaryActivated,
    lastExitCode: last?.exitCode ?? null,
    lastFailureKind: last?.failureKind ?? null,
    resolved
  };
}

async function writeResult(resultPath: string, result: AgentRunResult): Promise<void> {
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function createRuntime(variant: BenchmarkVariant, artifactDir: string, systemPrompt: string): VercelAICompressionRuntime {
  const compressedConfig = {
    maxContextTokens: variant.compression?.maxContextTokens ?? 3500,
    compressAtRatio: variant.compression?.compressAtRatio ?? 0.8,
    mode: variant.compression?.mode ?? "message",
    phaseCompressionEnabled: false,
    messageDecayEnabled: true,
    retrievalTopK: 0,
    keepPrefixMessages: variant.compression?.keepPrefixMessages ?? 1,
    keepSuffixMessages: variant.compression?.keepSuffixMessages ?? 3,
    recentRawWindowTokens: variant.compression?.recentRawWindowTokens ?? 1100,
    decayWarmStartTokens: variant.compression?.decayWarmStartTokens ?? 1400,
    decayTargetTokens: variant.compression?.decayTargetTokens ?? 1500,
    fibonacciBuckets: variant.compression?.fibonacciBuckets ?? [1, 2, 3, 5, 8, 13]
  } as const;

  const baselineConfig = {
    maxContextTokens: 100_000,
    compressAtRatio: 1,
    mode: "none" as const,
    phaseCompressionEnabled: false,
    messageDecayEnabled: false,
    retrievalTopK: 0,
    keepPrefixMessages: 1,
    keepSuffixMessages: 2,
    fibonacciBuckets: [1, 2, 3, 5, 8, 13]
  };

  const runtimeConfig = {
    systemPrompt,
    mainModel: variant.modelName,
    compression: variant.id === "compressed" ? compressedConfig : baselineConfig,
    dbPath: path.join(artifactDir, variant.id === "compressed" ? "apps-memory.sqlite" : "apps-baseline-memory.sqlite")
  } as const;

  return new VercelAICompressionRuntime(
    variant.id === "compressed" && variant.summarizerModel
      ? {
          ...runtimeConfig,
          summarizerModel: variant.summarizerModel
        }
      : runtimeConfig
  );
}

void main();
