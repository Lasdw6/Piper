import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readJsonlFile<T>(filename: string): Promise<T[]> {
  const raw = await readFile(filename, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export async function writeJsonlFile<T>(filename: string, rows: T[]): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const content = rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(filename, content.length > 0 ? `${content}\n` : "", "utf8");
}

export async function writeJsonFile<T>(filename: string, value: T): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
