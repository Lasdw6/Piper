import type { TraceEvent } from "../types.js";

export function estimateTokens(value: string): number {
  const normalized = value.trim();
  if (!normalized) {
    return 0;
  }

  return Math.ceil(normalized.length / 4);
}

export function eventTokenCost(event: TraceEvent): number {
  return estimateTokens(`${event.role}:${event.content}`);
}
