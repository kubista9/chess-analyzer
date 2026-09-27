import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

/** Writes JSON to a temp file next to the target, then renames it into place. */
export async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true });
    throw error;
  }
}

interface VersionedPayload<T> {
  schemaVersion: number;
  data: T;
}

/** Reads a `{schemaVersion, data}` file. A missing file or any other version is a cache miss. */
export async function readVersionedJson<T>(filePath: string, schemaVersion: number): Promise<T | null> {
  const payload = await readJsonFile<Partial<VersionedPayload<T>>>(filePath);
  if (!payload || payload.schemaVersion !== schemaVersion || payload.data === undefined) {
    return null;
  }

  return payload.data;
}

export async function writeVersionedJson<T>(filePath: string, schemaVersion: number, data: T): Promise<void> {
  await writeJsonFile(filePath, { schemaVersion, data } satisfies VersionedPayload<T>);
}

export function safeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-_]+/gi, "-");
}
