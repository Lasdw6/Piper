import test from "node:test";
import assert from "node:assert/strict";

import { CompressionLab } from "../src/lab.js";
import { scenarios } from "../src/scenarios.js";
import type { SummaryProvider, TraceEvent } from "../src/types.js";

test("phase mode archives old phases and keeps retrieval working", () => {
  const scenario = scenarios[0];
  assert.ok(scenario);

  const lab = new CompressionLab({
    mode: "phase",
    maxContextTokens: scenario.maxContextTokens,
    phaseCompressionEnabled: true,
    messageDecayEnabled: false
  });

  try {
    const result = lab.runScenario(scenario);
    assert.ok(result.archivedRecordCount > 0);
    assert.ok(result.compressionKeyCount > 0);
    assert.equal(result.probeResults[0]?.success, true);
  } finally {
    lab.close();
  }
});

test("message mode reduces working-set size below raw baseline", () => {
  const scenario = scenarios[1];
  assert.ok(scenario);

  const baseline = new CompressionLab({
    mode: "none",
    maxContextTokens: scenario.maxContextTokens,
    phaseCompressionEnabled: false,
    messageDecayEnabled: false
  });

  const decayed = new CompressionLab({
    mode: "message",
    maxContextTokens: scenario.maxContextTokens,
    phaseCompressionEnabled: false,
    messageDecayEnabled: true
  });

  try {
    const baselineResult = baseline.runScenario(scenario);
    const decayedResult = decayed.runScenario(scenario);
    assert.ok(decayedResult.compressionRatio < baselineResult.compressionRatio);
  } finally {
    baseline.close();
    decayed.close();
  }
});

test("async summary provider is used for archived phase keys", async () => {
  const provider: SummaryProvider = {
    summarizePhase(events: TraceEvent[]): Promise<string> {
      return Promise.resolve(`custom-summary:${events[0]?.phaseId ?? "unknown"}`);
    }
  };

  const lab = new CompressionLab(
    {
      mode: "phase",
      maxContextTokens: 400,
      phaseCompressionEnabled: true,
      messageDecayEnabled: false
    },
    undefined,
    provider
  );

  try {
    await lab.recordAsync({
      id: "s1",
      role: "user",
      content: "Inspect auth flow",
      phaseId: "inspect",
      timestamp: new Date().toISOString()
    });
    await lab.recordAsync({
      id: "s2",
      role: "tool",
      content: "rg auth src/",
      phaseId: "inspect",
      timestamp: new Date().toISOString()
    });
    await lab.recordAsync({
      id: "s3",
      role: "assistant",
      content: "Found redirect handling in middleware.ts",
      phaseId: "inspect",
      timestamp: new Date().toISOString()
    });
    const snapshot = await lab.recordAsync({
      id: "s4",
      role: "user",
      content: "Continue to verification",
      phaseId: "verify",
      timestamp: new Date().toISOString()
    });

    assert.equal(snapshot.archivedKeys[0]?.summary, "custom-summary:inspect");
  } finally {
    lab.close();
  }
});
