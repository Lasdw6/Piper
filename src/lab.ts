import {
  buildWorkingSet,
  createInitialCompressionState,
  enforceThreshold,
  maybeArchiveOldPhases,
  maybeArchiveOldPhasesAsync,
  sumTokens
} from "./algorithm/compression.js";
import { MemoryStore } from "./memory-store.js";
import type {
  CompressionConfig,
  ProbeResult,
  RetrievalResult,
  Scenario,
  ScenarioProbe,
  ScenarioResult,
  SummaryProvider,
  TraceEvent,
  WorkingSetSnapshot
} from "./types.js";

export const DEFAULT_CONFIG: CompressionConfig = {
  mode: "hybrid",
  maxContextTokens: 1200,
  compressAtRatio: 0.8,
  retrievalTopK: 3,
  phaseCompressionEnabled: true,
  messageDecayEnabled: true,
  fibonacciBuckets: [1, 2, 3, 5, 8, 13],
  pinSystemPrompt: true,
  pinCurrentPhase: true
};

export class CompressionLab {
  private readonly config: CompressionConfig;
  private readonly memoryStore: MemoryStore;
  private readonly summaryProvider: SummaryProvider | undefined;
  private readonly events: TraceEvent[] = [];
  private readonly state = createInitialCompressionState();
  private maxObservedTokens = 0;
  private thresholdBreaches = 0;

  constructor(config: Partial<CompressionConfig> = {}, dbPath?: string, summaryProvider?: SummaryProvider) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.memoryStore = new MemoryStore(dbPath);
    this.summaryProvider = summaryProvider;
  }

  record(event: TraceEvent): WorkingSetSnapshot {
    this.events.push(event);
    const newKeys = maybeArchiveOldPhases(this.events, this.config, this.state);
    this.persistArchivedKeys(newKeys);
    return this.finalizeSnapshot();
  }

  async recordAsync(event: TraceEvent): Promise<WorkingSetSnapshot> {
    this.events.push(event);
    const newKeys = this.summaryProvider
      ? await maybeArchiveOldPhasesAsync(this.events, this.config, this.state, this.summaryProvider)
      : maybeArchiveOldPhases(this.events, this.config, this.state);
    this.persistArchivedKeys(newKeys);
    return this.finalizeSnapshot();
  }

  runScenario(scenario: Scenario): ScenarioResult {
    const probeResults: ProbeResult[] = [];
    const probesByEventId = new Map<string, ScenarioProbe[]>();

    for (const probe of scenario.probes) {
      const existing = probesByEventId.get(probe.atEventId) ?? [];
      existing.push(probe);
      probesByEventId.set(probe.atEventId, existing);
    }

    for (const event of scenario.events) {
      this.record(event);
      const probes = probesByEventId.get(event.id) ?? [];
      for (const probe of probes) {
        probeResults.push(this.evaluateProbe(probe));
      }
    }

    const successfulProbes = probeResults.filter((probe) => probe.success).length;
    const snapshot = this.nextContext();
    const rawTokens = this.events.reduce((sum, event) => sum + Math.ceil(event.content.length / 4), 0);
    const compressionRatio = rawTokens === 0 ? 1 : snapshot.totalTokens / rawTokens;

    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      mode: this.config.mode,
      eventsProcessed: scenario.events.length,
      archivedRecordCount: this.memoryStore.countRecords(),
      compressionKeyCount: this.state.keys.length,
      probeSuccessRate: probeResults.length === 0 ? 1 : successfulProbes / probeResults.length,
      compressionRatio,
      maxObservedTokens: this.maxObservedTokens,
      thresholdBreaches: this.thresholdBreaches,
      probeResults
    };
  }

  async runScenarioAsync(scenario: Scenario): Promise<ScenarioResult> {
    const probeResults: ProbeResult[] = [];
    const probesByEventId = new Map<string, ScenarioProbe[]>();

    for (const probe of scenario.probes) {
      const existing = probesByEventId.get(probe.atEventId) ?? [];
      existing.push(probe);
      probesByEventId.set(probe.atEventId, existing);
    }

    for (const event of scenario.events) {
      await this.recordAsync(event);
      const probes = probesByEventId.get(event.id) ?? [];
      for (const probe of probes) {
        probeResults.push(this.evaluateProbe(probe));
      }
    }

    const successfulProbes = probeResults.filter((probe) => probe.success).length;
    const snapshot = this.nextContext();
    const rawTokens = this.events.reduce((sum, event) => sum + Math.ceil(event.content.length / 4), 0);
    const compressionRatio = rawTokens === 0 ? 1 : snapshot.totalTokens / rawTokens;

    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      mode: this.config.mode,
      eventsProcessed: scenario.events.length,
      archivedRecordCount: this.memoryStore.countRecords(),
      compressionKeyCount: this.state.keys.length,
      probeSuccessRate: probeResults.length === 0 ? 1 : successfulProbes / probeResults.length,
      compressionRatio,
      maxObservedTokens: this.maxObservedTokens,
      thresholdBreaches: this.thresholdBreaches,
      probeResults
    };
  }

  nextContext(): WorkingSetSnapshot {
    const thresholdTokens = Math.floor(this.config.maxContextTokens * this.config.compressAtRatio);
    let items = buildWorkingSet(this.events, this.config, this.state);
    items = enforceThreshold(items, thresholdTokens);

    return {
      mode: this.config.mode,
      totalTokens: sumTokens(items),
      thresholdTokens,
      items,
      archivedKeys: [...this.state.keys]
    };
  }

  retrieve(query: string): RetrievalResult {
    return this.memoryStore.retrieve(query, this.config.retrievalTopK);
  }

  close(): void {
    this.memoryStore.close();
  }

  private evaluateProbe(probe: ScenarioProbe): ProbeResult {
    const retrieval = this.retrieve(probe.query);
    const match = probe.expectAny.find((expectation) =>
      retrieval.hits.some((hit) => hit.record.rawText.includes(expectation) || hit.record.summary.includes(expectation))
    );

    const result: ProbeResult = {
      probeId: probe.id,
      success: match !== undefined,
      hits: retrieval.hits
    };

    if (match !== undefined) {
      result.matchedExpectation = match;
    }

    return result;
  }

  private persistArchivedKeys(keys: { id: string; sourceEventIds: string[]; phaseId: string; summary: string; createdAt: string }[]): void {
    for (const key of keys) {
      const rawText = this.events
        .filter((entry) => key.sourceEventIds.includes(entry.id))
        .map((entry) => `[${entry.role}] ${entry.content}`)
        .join("\n");
      this.memoryStore.archive(key, rawText);
    }
  }

  private finalizeSnapshot(): WorkingSetSnapshot {
    const snapshot = this.nextContext();
    if (snapshot.totalTokens > snapshot.thresholdTokens) {
      this.thresholdBreaches += 1;
    }
    this.maxObservedTokens = Math.max(this.maxObservedTokens, snapshot.totalTokens);
    return snapshot;
  }
}
