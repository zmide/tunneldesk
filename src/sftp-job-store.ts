import fs from "node:fs";
import path from "node:path";

export interface PersistedSftpJob {
  id?: string;
  created_at?: number;
  [key: string]: unknown;
}

export function readSftpJobHistory(file: string): PersistedSftpJob[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { jobs?: unknown };
    return Array.isArray(parsed.jobs)
      ? parsed.jobs.filter(item => Boolean(item) && typeof item === "object") as PersistedSftpJob[]
      : [];
  } catch {
    return [];
  }
}

export function writeSftpJobHistoryAtomic(
  file: string,
  items: PersistedSftpJob[],
  maximum = 120
): PersistedSftpJob[] {
  const normalized = items
    .filter(item => Boolean(item) && typeof item === "object")
    .sort((left, right) => Number(right.created_at || 0) - Number(left.created_at || 0))
    .slice(0, maximum);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ jobs: normalized }, null, 2), "utf8");
    fs.renameSync(temporary, file);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
  return normalized;
}
