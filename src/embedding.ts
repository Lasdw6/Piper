const VECTOR_SIZE = 64;

export function embedText(value: string): number[] {
  const vector = new Array<number>(VECTOR_SIZE).fill(0);
  const tokens = tokenize(value);

  for (const token of tokens) {
    let hash = 2166136261;
    for (let index = 0; index < token.length; index += 1) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    const position = Math.abs(hash) % VECTOR_SIZE;
    vector[position] = (vector[position] ?? 0) + 1;
  }

  return normalize(vector);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function extractKeywords(value: string, limit = 8): string[] {
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "into",
    "then",
    "than",
    "were",
    "have",
    "has",
    "had",
    "tool",
    "assistant",
    "user",
    "call",
    "response"
  ]);

  const counts = new Map<string, number>();
  for (const token of tokenize(value)) {
    if (token.length < 3 || stopWords.has(token)) {
      continue;
    }

    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([token]) => token);
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    return vector;
  }

  return vector.map((value) => value / norm);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter(Boolean);
}
