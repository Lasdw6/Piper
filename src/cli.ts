import { CompressionLab } from "./lab.js";
import { scenarios } from "./scenarios.js";
import type { CompressionMode, ScenarioResult } from "./types.js";

const modes: CompressionMode[] = ["none", "phase", "message", "hybrid"];

function main(): void {
  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    for (const mode of modes) {
      const lab = new CompressionLab({
        mode,
        maxContextTokens: scenario.maxContextTokens,
        phaseCompressionEnabled: mode === "phase" || mode === "hybrid",
        messageDecayEnabled: mode === "message" || mode === "hybrid"
      });

      try {
        results.push(lab.runScenario(scenario));
      } finally {
        lab.close();
      }
    }
  }

  printResults(results);
}

function printResults(results: ScenarioResult[]): void {
  console.log("");
  console.log("Continuous Context Compression Lab");
  console.log("=".repeat(40));

  for (const result of results) {
    console.log("");
    console.log(`${result.scenarioName} | mode=${result.mode}`);
    console.log(`events=${result.eventsProcessed}`);
    console.log(`compression_ratio=${result.compressionRatio.toFixed(2)}`);
    console.log(`max_observed_tokens=${result.maxObservedTokens}`);
    console.log(`archived_records=${result.archivedRecordCount}`);
    console.log(`compression_keys=${result.compressionKeyCount}`);
    console.log(`probe_success_rate=${result.probeSuccessRate.toFixed(2)}`);
    console.log(`threshold_breaches=${result.thresholdBreaches}`);
  }
}

main();
