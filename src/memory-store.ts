import Database from "better-sqlite3";

import { cosineSimilarity, embedText, extractKeywords } from "./embedding.js";
import type { CompressionKey, MemoryRecord, RetrievalResult } from "./types.js";

interface RecordRow {
  id: string;
  key_id: string;
  phase_id: string;
  raw_text: string;
  summary: string;
  keywords: string;
  embedding: string;
  source_event_ids: string;
  created_at: string;
}

export class MemoryStore {
  private readonly database: Database.Database;

  constructor(filename = ":memory:") {
    this.database = new Database(filename);
    this.database.pragma("journal_mode = WAL");
    this.initialize();
  }

  archive(key: CompressionKey, rawText: string): MemoryRecord {
    const record: MemoryRecord = {
      id: `mem_${key.id}`,
      keyId: key.id,
      phaseId: key.phaseId,
      rawText,
      summary: key.summary,
      keywords: extractKeywords(`${key.summary}\n${rawText}`),
      embedding: embedText(`${key.summary}\n${rawText}`),
      sourceEventIds: key.sourceEventIds,
      createdAt: key.createdAt
    };

    const insert = this.database.prepare(`
      INSERT OR REPLACE INTO archived_records (
        id, key_id, phase_id, raw_text, summary, keywords, embedding, source_event_ids, created_at
      ) VALUES (
        @id, @key_id, @phase_id, @raw_text, @summary, @keywords, @embedding, @source_event_ids, @created_at
      )
    `);

    insert.run({
      id: record.id,
      key_id: record.keyId,
      phase_id: record.phaseId,
      raw_text: record.rawText,
      summary: record.summary,
      keywords: JSON.stringify(record.keywords),
      embedding: JSON.stringify(record.embedding),
      source_event_ids: JSON.stringify(record.sourceEventIds),
      created_at: record.createdAt
    });

    const ftsInsert = this.database.prepare(`
      INSERT OR REPLACE INTO archived_records_fts (rowid, id, searchable_text)
      VALUES ((SELECT rowid FROM archived_records WHERE id = ?), ?, ?)
    `);

    ftsInsert.run(record.id, record.id, `${record.summary}\n${record.rawText}\n${record.keyId}`);
    return record;
  }

  retrieve(query: string, topK: number): RetrievalResult {
    const exact = this.database
      .prepare(`
        SELECT * FROM archived_records
        WHERE key_id = ? OR id = ?
      `)
      .all(query, query) as RecordRow[];

    const exactIds = new Set(exact.map((row) => row.id));
    const keywordRows = this.database
      .prepare(`
        SELECT archived_records.*
        FROM archived_records_fts
        JOIN archived_records ON archived_records_fts.rowid = archived_records.rowid
        WHERE archived_records_fts MATCH ?
        LIMIT ?
      `)
      .all(sanitizeFtsQuery(query), topK * 2) as RecordRow[];

    const queryEmbedding = embedText(query);
    const vectorRows = this.database
      .prepare(`SELECT * FROM archived_records LIMIT 200`)
      .all() as RecordRow[];

    const results = new Map<string, { row: RecordRow; score: number; matchType: "exact" | "keyword" | "vector" }>();

    for (const row of exact) {
      results.set(row.id, { row, score: 1.5, matchType: "exact" });
    }

    for (const row of keywordRows) {
      if (exactIds.has(row.id)) {
        continue;
      }

      results.set(row.id, { row, score: 1.0, matchType: "keyword" });
    }

    for (const row of vectorRows) {
      if (results.has(row.id)) {
        continue;
      }

      const vector = JSON.parse(row.embedding) as number[];
      const score = cosineSimilarity(queryEmbedding, vector);
      if (score < 0.12) {
        continue;
      }

      results.set(row.id, { row, score, matchType: "vector" });
    }

    const hits = [...results.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, topK)
      .map(({ row, score, matchType }) => ({
        record: hydrateRecord(row),
        score,
        matchType
      }));

    return {
      query,
      hits
    };
  }

  countRecords(): number {
    const result = this.database.prepare(`SELECT COUNT(*) as count FROM archived_records`).get() as { count: number };
    return result.count;
  }

  close(): void {
    this.database.close();
  }

  private initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS archived_records (
        id TEXT PRIMARY KEY,
        key_id TEXT NOT NULL,
        phase_id TEXT NOT NULL,
        raw_text TEXT NOT NULL,
        summary TEXT NOT NULL,
        keywords TEXT NOT NULL,
        embedding TEXT NOT NULL,
        source_event_ids TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS archived_records_fts USING fts5(
        id,
        searchable_text
      );
    `);
  }
}

function hydrateRecord(row: RecordRow): MemoryRecord {
  return {
    id: row.id,
    keyId: row.key_id,
    phaseId: row.phase_id,
    rawText: row.raw_text,
    summary: row.summary,
    keywords: JSON.parse(row.keywords) as string[],
    embedding: JSON.parse(row.embedding) as number[],
    sourceEventIds: JSON.parse(row.source_event_ids) as string[],
    createdAt: row.created_at
  };
}

function sanitizeFtsQuery(query: string): string {
  const cleaned = query
    .trim()
    .split(/[^a-zA-Z0-9_]+/)
    .filter(Boolean)
    .map((token) => `${token}*`);

  return cleaned.length > 0 ? cleaned.join(" OR ") : "placeholder";
}
