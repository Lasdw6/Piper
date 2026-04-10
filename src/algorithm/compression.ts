import { estimateTokens } from "./tokenizer.js";
import type { CompressionConfig, CompressionKey, SummaryProvider, TraceEvent, WorkingSetItem } from "../types.js";

export interface CompressionState {
  keys: CompressionKey[];
  archivedPhaseIds: Set<string>;
}

export function createInitialCompressionState(): CompressionState {
  return {
    keys: [],
    archivedPhaseIds: new Set<string>()
  };
}

export function buildWorkingSet(
  events: TraceEvent[],
  config: CompressionConfig,
  state: CompressionState
): WorkingSetItem[] {
  if (config.mode === "none") {
    return events.map((event) => toRawItem(event));
  }

  const latestPhaseId = events.at(-1)?.phaseId;
  const phaseGroups = groupByPhase(events);
  const items: WorkingSetItem[] = [];

  for (const [phaseId, phaseEvents] of phaseGroups) {
    const isCurrentPhase = latestPhaseId !== undefined && phaseId === latestPhaseId;
    const isPinnedPhase = config.pinCurrentPhase && isCurrentPhase;
    const shouldCompressPhase =
      config.phaseCompressionEnabled &&
      (config.mode === "phase" || config.mode === "hybrid") &&
      !isPinnedPhase &&
      state.archivedPhaseIds.has(phaseId);

    if (shouldCompressPhase) {
      const key = state.keys.find((entry) => entry.phaseId === phaseId);
      if (key) {
        items.push({
          id: key.id,
          role: "meta",
          kind: "compressed",
          content: key.summary,
          tokens: estimateTokens(key.summary),
          phaseId,
          sourceEventIds: key.sourceEventIds
        });
        continue;
      }
    }

    for (const event of phaseEvents) {
      items.push(toRawItem(event));
    }
  }

  if (!config.messageDecayEnabled || (config.mode !== "message" && config.mode !== "hybrid")) {
    return items;
  }

  // When decayWarmStartTokens is explicitly configured, mirror the Python bridge: only trigger
  // decay once context exceeds that threshold. Without this guard, decay fires on every call
  // even when well within budget, shredding context the agent still needs.
  if (config.decayWarmStartTokens !== undefined && sumTokens(items) <= config.decayWarmStartTokens) {
    return items;
  }

  return applyMessageDecay(items, config);
}

export function maybeArchiveOldPhases(
  events: TraceEvent[],
  config: CompressionConfig,
  state: CompressionState
): CompressionKey[] {
  if (!config.phaseCompressionEnabled || (config.mode !== "phase" && config.mode !== "hybrid")) {
    return [];
  }

  const latestPhaseId = events.at(-1)?.phaseId;
  const groups = groupByPhase(events);
  const newKeys: CompressionKey[] = [];

  for (const [phaseId, phaseEvents] of groups) {
    if (phaseId === latestPhaseId || state.archivedPhaseIds.has(phaseId)) {
      continue;
    }

    const hasPinned = phaseEvents.some((event) => event.pinned || (event.role === "system" && config.pinSystemPrompt));
    if (hasPinned || phaseEvents.length < 1) {
      continue;
    }

    const summary = buildHeuristicPhaseSummary(phaseEvents);
    const key: CompressionKey = {
      id: `K${state.keys.length + newKeys.length + 1}`,
      phaseId,
      summary,
      sourceEventIds: phaseEvents.map((event) => event.id),
      createdAt: new Date().toISOString()
    };

    state.archivedPhaseIds.add(phaseId);
    state.keys.push(key);
    newKeys.push(key);
  }

  return newKeys;
}

export async function maybeArchiveOldPhasesAsync(
  events: TraceEvent[],
  config: CompressionConfig,
  state: CompressionState,
  summaryProvider: SummaryProvider
): Promise<CompressionKey[]> {
  if (!config.phaseCompressionEnabled || (config.mode !== "phase" && config.mode !== "hybrid")) {
    return [];
  }

  const latestPhaseId = events.at(-1)?.phaseId;
  const groups = groupByPhase(events);
  const newKeys: CompressionKey[] = [];

  for (const [phaseId, phaseEvents] of groups) {
    if (phaseId === latestPhaseId || state.archivedPhaseIds.has(phaseId)) {
      continue;
    }

    const hasPinned = phaseEvents.some((event) => event.pinned || (event.role === "system" && config.pinSystemPrompt));
    if (hasPinned || phaseEvents.length < 1) {
      continue;
    }

    const summary = await summaryProvider.summarizePhase(phaseEvents);
    const key: CompressionKey = {
      id: `K${state.keys.length + newKeys.length + 1}`,
      phaseId,
      summary,
      sourceEventIds: phaseEvents.map((event) => event.id),
      createdAt: new Date().toISOString()
    };

    state.archivedPhaseIds.add(phaseId);
    state.keys.push(key);
    newKeys.push(key);
  }

  return newKeys;
}

export function enforceThreshold(items: WorkingSetItem[], thresholdTokens: number): WorkingSetItem[] {
  const result = [...items];
  const exhausted = new Set<number>();

  while (sumTokens(result) > thresholdTokens) {
    const candidateIndex = result.findIndex(
      (item, i) => !exhausted.has(i) && (item.kind === "raw" || item.kind === "decayed") && item.role !== "system"
    );
    if (candidateIndex === -1) {
      break;
    }

    const candidate = result[candidateIndex];
    if (!candidate) {
      break;
    }

    const tightened = shorten(candidate.content, Math.max(12, Math.floor(candidate.tokens * 0.45)));
    const newTokens = estimateTokens(tightened);

    if (newTokens >= candidate.tokens) {
      exhausted.add(candidateIndex);
      continue;
    }

    result[candidateIndex] = {
      ...candidate,
      kind: "decayed",
      content: tightened,
      tokens: newTokens
    };
  }

  return result;
}

export function sumTokens(items: WorkingSetItem[]): number {
  return items.reduce((total, item) => total + item.tokens, 0);
}

function applyMessageDecay(items: WorkingSetItem[], config: CompressionConfig): WorkingSetItem[] {
  const decayed = [...items];

  // Determine target for early-exit. Only applies when decayTargetTokens is explicitly set;
  // otherwise we let age-based ratios run fully (original behaviour, keeps tests green).
  const effectiveTarget: number | undefined = (() => {
    if (config.decayTargetTokens === undefined) return undefined;
    const emergency = config.decayEmergencyTokens;
    return emergency !== undefined && sumTokens(decayed) > emergency
      ? Math.min(config.decayTargetTokens, Math.floor(config.decayTargetTokens * 0.94))
      : config.decayTargetTokens;
  })();

  // Shield the most-recent recentRawWindowTokens of raw content from decay.
  // This preserves the context the agent needs most while compressing older content.
  const recentWindowTokens = config.recentRawWindowTokens ?? 0;
  let recentBudget = recentWindowTokens;
  const shielded = new Set<number>();
  for (let i = decayed.length - 1; i >= 0; i--) {
    const item = decayed[i];
    if (!item) continue;
    if (item.role === "system") { shielded.add(i); continue; }
    if (recentBudget > 0 && item.kind === "raw") {
      shielded.add(i);
      recentBudget -= item.tokens;
    }
  }

  const latestIndex = decayed.length - 1;
  const buckets = [...config.fibonacciBuckets].sort((left, right) => left - right);
  const ratios = [1, 0.72, 0.55, 0.4, 0.28, 0.18, 0.12];

  for (let index = 0; index < decayed.length; index += 1) {
    // Stop as soon as we've hit the configured target — don't over-compress.
    if (effectiveTarget !== undefined && sumTokens(decayed) <= effectiveTarget) {
      break;
    }

    const item = decayed[index];
    if (!item || item.kind !== "raw" || item.role === "system" || shielded.has(index)) {
      continue;
    }

    const age = latestIndex - index;
    const bucketIndex = buckets.findIndex((bucket) => age <= bucket);
    const ratioIndex = bucketIndex === -1 ? ratios.length - 1 : bucketIndex;
    const ratio = ratios[ratioIndex] ?? ratios[ratios.length - 1] ?? 1;

    if (ratio >= 0.99) {
      continue;
    }

    const nextBudget = Math.max(10, Math.floor(item.tokens * ratio));
    const compressed = shorten(item.content, nextBudget);
    decayed[index] = {
      ...item,
      kind: "decayed",
      content: compressed,
      tokens: estimateTokens(compressed)
    };
  }

  return decayed;
}

function groupByPhase(events: TraceEvent[]): Map<string, TraceEvent[]> {
  const groups = new Map<string, TraceEvent[]>();
  for (const event of events) {
    const existing = groups.get(event.phaseId) ?? [];
    existing.push(event);
    groups.set(event.phaseId, existing);
  }

  return groups;
}

function toRawItem(event: TraceEvent): WorkingSetItem {
  return {
    id: event.id,
    role: event.role,
    kind: "raw",
    content: event.content,
    tokens: estimateTokens(event.content),
    phaseId: event.phaseId,
    sourceEventIds: [event.id]
  };
}

export function buildHeuristicPhaseSummary(events: TraceEvent[]): string {
  const labels = new Set(events.flatMap((event) => event.tags ?? []));
  const noteworthy = events
    .filter((event) => event.role === "tool" || event.role === "assistant")
    .map((event) => event.content.trim())
    .filter(Boolean)
    .slice(0, 2);

  const prefix = labels.size > 0 ? `${[...labels].slice(0, 2).join(", ")}: ` : "";
  const summarySource =
    noteworthy.join(" | ") ||
    events
      .map((event) => event.content.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(" | ");
  const rawTokenBudget = Math.max(
    12,
    Math.floor(
      events.reduce((sum, event) => sum + estimateTokens(event.content), 0) * 0.35
    )
  );
  const compact = shorten(summarySource, Math.min(18, rawTokenBudget));

  return `${prefix}${compact}`;
}

function shorten(content: string, targetTokens: number): string {
  const trimmed = content.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  const targetChars = Math.max(24, targetTokens * 4);
  if (trimmed.length <= targetChars) {
    return trimmed;
  }

  const headChars = Math.max(12, Math.floor(targetChars * 0.68));
  const tailChars = Math.max(8, targetChars - headChars - 5);
  const head = trimmed.slice(0, headChars).trimEnd();
  const tail = trimmed.slice(-tailChars).trimStart();

  if (head.length + tail.length + 5 >= trimmed.length) {
    const headCount = Math.max(3, Math.floor(words.length * 0.6));
    const tailCount = Math.max(2, Math.floor(words.length * 0.2));
    if (headCount + tailCount >= words.length) {
      return trimmed;
    }
    return `${words.slice(0, headCount).join(" ")} ... ${words.slice(-tailCount).join(" ")}`;
  }

  return `${head} ... ${tail}`;
}
