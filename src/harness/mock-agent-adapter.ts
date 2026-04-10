import type { AgentAdapter, AgentRunContext, AgentRunResult, BenchmarkTask, BenchmarkVariant } from "./benchmark-types.js";

export class MockAgentAdapter implements AgentAdapter {
  readonly name = "mock-agent";

  async runTask(task: BenchmarkTask, variant: BenchmarkVariant, _context?: AgentRunContext): Promise<AgentRunResult> {
    const baseline = variant.id === "baseline";
    const inputTokens = baseline ? 1800 : 1050;
    const outputTokens = baseline ? 320 : 300;

    return {
      patch: `diff --git a/${task.repo}/file.py b/${task.repo}/file.py\n+ # synthetic patch for ${task.instanceId}\n`,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens
      },
      turnUsages: [
        {
          turnId: `${task.instanceId}-t1`,
          phaseId: "investigate",
          model: variant.modelName,
          kind: "response",
          inputTokens: baseline ? 700 : 420,
          outputTokens: 120,
          totalTokens: baseline ? 820 : 540
        },
        {
          turnId: `${task.instanceId}-t2`,
          phaseId: "patch",
          model: variant.modelName,
          kind: "response",
          inputTokens: baseline ? 1100 : 630,
          outputTokens: baseline ? 200 : 180,
          totalTokens: baseline ? 1300 : 810
        }
      ],
      summary: `Mock run for ${task.instanceId} in ${variant.id} mode`
    };
  }
}
