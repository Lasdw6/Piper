export type EventRole = "system" | "user" | "assistant" | "tool" | "meta";
export type CompressionMode = "none" | "phase" | "message" | "hybrid";

export interface TraceEvent {
  id: string;
  role: EventRole;
  content: string;
  phaseId: string;
  timestamp: string;
  tags?: string[];
  metadata?: Record<string, string | number | boolean | null>;
  pinned?: boolean;
}

export interface CompressionKey {
  id: string;
  phaseId: string;
  summary: string;
  sourceEventIds: string[];
  createdAt: string;
}

export interface MemoryRecord {
  id: string;
  keyId: string;
  phaseId: string;
  rawText: string;
  summary: string;
  keywords: string[];
  embedding: number[];
  sourceEventIds: string[];
  createdAt: string;
}

export interface WorkingSetItem {
  id: string;
  role: EventRole;
  kind: "raw" | "compressed" | "decayed";
  content: string;
  tokens: number;
  phaseId: string;
  sourceEventIds: string[];
}

export interface WorkingSetSnapshot {
  mode: CompressionMode;
  totalTokens: number;
  thresholdTokens: number;
  items: WorkingSetItem[];
  archivedKeys: CompressionKey[];
}

export interface RetrievalHit {
  record: MemoryRecord;
  score: number;
  matchType: "keyword" | "vector" | "exact";
}

export interface RetrievalResult {
  query: string;
  hits: RetrievalHit[];
}

export interface CompressionConfig {
  mode: CompressionMode;
  maxContextTokens: number;
  compressAtRatio: number;
  summarizerModel?: string;
  mainModel?: string;
  retrievalTopK: number;
  phaseCompressionEnabled: boolean;
  phaseCompressionRoles?: EventRole[];
  toolMicrocompactEnabled?: boolean;
  toolMicrocompactThresholdTokens?: number;
  toolMicrocompactKeepRecentToolMessages?: number;
  toolMicrocompactMinMessageTokens?: number;
  toolMicrocompactMinMessageChars?: number;
  messageDecayEnabled: boolean;
  decayCandidateRoles?: EventRole[];
  decayWarmStartTokens?: number;
  decayTargetTokens?: number;
  recentRawWindowTokens?: number;
  decayEmergencyTokens?: number;
  keepPrefixMessages?: number;
  keepSuffixMessages?: number;
  maxApiCalls?: number;
  maxRetrievalCount?: number;
  maxSummaryCalls?: number;
  maxArchiveRecords?: number;
  maxRepeatedPromptFingerprints?: number;
  mainTpmLimit?: number;
  mainTpmReserveTokens?: number;
  fibonacciBuckets: number[];
  pinSystemPrompt: boolean;
  pinCurrentPhase: boolean;
}

export interface ScenarioProbe {
  id: string;
  atEventId: string;
  query: string;
  expectAny: string[];
}

export interface Scenario {
  id: string;
  name: string;
  maxContextTokens: number;
  events: TraceEvent[];
  probes: ScenarioProbe[];
}

export interface ProbeResult {
  probeId: string;
  success: boolean;
  matchedExpectation?: string;
  hits: RetrievalHit[];
}

export interface ScenarioResult {
  scenarioId: string;
  scenarioName: string;
  mode: CompressionMode;
  eventsProcessed: number;
  archivedRecordCount: number;
  compressionKeyCount: number;
  probeSuccessRate: number;
  compressionRatio: number;
  maxObservedTokens: number;
  thresholdBreaches: number;
  probeResults: ProbeResult[];
}

export interface SummaryProvider {
  summarizePhase(events: TraceEvent[]): Promise<string>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TurnUsage extends TokenUsage {
  turnId: string;
  phaseId: string;
  model: string;
  kind: "summary" | "response";
}
