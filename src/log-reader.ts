import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

export interface LogSettings {
  schema_version: number;
  retention_days: number;
  max_file_size_mb: number;
  max_total_size_mb: number;
  rotation_files: number;
  updated_at?: string;
}

export interface LogWindowOptions {
  beforeOffset?: number;
  limitBytes?: number;
  raw?: boolean;
  query?: string;
  contextLines?: number;
  maxMatches?: number;
}

export interface LogSearchMatch {
  line: number;
  text: string;
}

export interface LogWindowResult {
  text: string;
  offset: number;
  end_offset: number;
  total_bytes: number;
  has_older: boolean;
  has_newer: boolean;
  matches: LogSearchMatch[];
  matches_truncated: boolean;
}

export const DEFAULT_LOG_SETTINGS: LogSettings = {
  schema_version: 1,
  retention_days: 90,
  max_file_size_mb: 50,
  max_total_size_mb: 1024,
  rotation_files: 3
};

function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

export function normalizeLogSettings(value: Partial<LogSettings> = {}): LogSettings {
  return {
    schema_version: 1,
    retention_days: clampInteger(value.retention_days, DEFAULT_LOG_SETTINGS.retention_days, 0, 3650),
    max_file_size_mb: clampInteger(value.max_file_size_mb, DEFAULT_LOG_SETTINGS.max_file_size_mb, 1, 2048),
    max_total_size_mb: clampInteger(value.max_total_size_mb, DEFAULT_LOG_SETTINGS.max_total_size_mb, 10, 102400),
    rotation_files: clampInteger(value.rotation_files, DEFAULT_LOG_SETTINGS.rotation_files, 1, 10),
    ...(value.updated_at ? { updated_at: String(value.updated_at) } : {})
  };
}

export function readLogSettings(file: string): LogSettings {
  try {
    return normalizeLogSettings(JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LogSettings>);
  } catch {
    return { ...DEFAULT_LOG_SETTINGS };
  }
}

export function writeLogSettings(file: string, value: Partial<LogSettings>): LogSettings {
  const settings = { ...normalizeLogSettings(value), updated_at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), "utf8");
    fs.renameSync(temporary, file);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
  return settings;
}

export function resolveLogFile(logDir: string, relativePath: string): string {
  const root = path.resolve(logDir);
  const resolved = path.resolve(root, String(relativePath || ""));
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("日志路径无效");
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error("日志不存在");
  return resolved;
}

function renderTerminalControls(text: string): string {
  const lines: string[][] = [[]];
  let cursor = 0;
  for (const character of text) {
    const line = lines[lines.length - 1];
    if (character === "\r") {
      cursor = 0;
      continue;
    }
    if (character === "\n") {
      lines.push([]);
      cursor = 0;
      continue;
    }
    if (character === "\b" || character === "\x7f") {
      cursor = Math.max(0, cursor - 1);
      continue;
    }
    if (character === "\t") {
      const next = cursor + (8 - (cursor % 8));
      while (line.length < next) line.push(" ");
      cursor = next;
      continue;
    }
    if (character < " " || character === "\x7f") continue;
    while (line.length < cursor) line.push(" ");
    line[cursor] = character;
    cursor += 1;
  }
  return lines.map(line => line.join("").trimEnd()).join("\n");
}

function stripAnsi(text: string): string {
  const withoutAnsi = text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[PX^_][\s\S]*?\x1B\\)/g, "");
  return renderTerminalControls(withoutAnsi);
}

async function searchLog(
  file: string,
  query: string,
  contextLines: number,
  maxMatches: number,
  raw: boolean
): Promise<{ matches: LogSearchMatch[]; truncated: boolean }> {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { matches: [], truncated: false };
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const previous: Array<{ line: number; text: string }> = [];
  const pending: Array<{ line: number; rows: Array<{ line: number; text: string }>; remaining: number }> = [];
  const completed: LogSearchMatch[] = [];
  let lineNumber = 0;
  let truncated = false;
  for await (const sourceLine of lines) {
    lineNumber += 1;
    const text = raw ? sourceLine : stripAnsi(sourceLine);
    for (const block of pending) {
      if (block.remaining <= 0) continue;
      block.rows.push({ line: lineNumber, text });
      block.remaining -= 1;
    }
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (pending[index].remaining > 0) continue;
      const block = pending.splice(index, 1)[0];
      completed.push({
        line: block.line,
        text: block.rows.map(row => `${row.line}: ${row.text}`).join("\n")
      });
    }
    const lower = text.toLowerCase();
    if (terms.some(term => lower.includes(term))) {
      if (completed.length + pending.length >= maxMatches) {
        truncated = true;
      } else {
        pending.push({
          line: lineNumber,
          rows: [...previous, { line: lineNumber, text }],
          remaining: contextLines
        });
      }
    }
    previous.push({ line: lineNumber, text });
    while (previous.length > contextLines) previous.shift();
  }
  for (const block of pending) {
    completed.push({
      line: block.line,
      text: block.rows.map(row => `${row.line}: ${row.text}`).join("\n")
    });
  }
  return { matches: completed.slice(0, maxMatches), truncated };
}

export async function readLogWindow(
  logDir: string,
  relativePath: string,
  options: LogWindowOptions = {}
): Promise<LogWindowResult> {
  const file = resolveLogFile(logDir, relativePath);
  const stat = await fs.promises.stat(file);
  const total = stat.size;
  const limit = clampInteger(options.limitBytes, 256 * 1024, 4096, 1024 * 1024);
  const end = options.beforeOffset === undefined
    ? total
    : Math.max(0, Math.min(total, Math.floor(Number(options.beforeOffset) || 0)));
  const start = Math.max(0, end - limit);
  const length = Math.max(0, end - start);
  const handle = await fs.promises.open(file, "r");
  let buffer = Buffer.alloc(length);
  try {
    if (length) {
      const result = await handle.read(buffer, 0, length, start);
      buffer = buffer.subarray(0, result.bytesRead);
    }
  } finally {
    await handle.close();
  }
  let text = buffer.toString("utf8");
  if (start > 0) {
    const firstLineEnd = text.indexOf("\n");
    if (firstLineEnd >= 0) text = text.slice(firstLineEnd + 1);
  }
  if (!options.raw) text = stripAnsi(text);
  const searched = await searchLog(
    file,
    String(options.query || ""),
    clampInteger(options.contextLines, 2, 0, 10),
    clampInteger(options.maxMatches, 50, 1, 200),
    Boolean(options.raw)
  );
  return {
    text,
    offset: start,
    end_offset: end,
    total_bytes: total,
    has_older: start > 0,
    has_newer: end < total,
    matches: searched.matches,
    matches_truncated: searched.truncated
  };
}

function walkLogFiles(root: string): Array<{ file: string; stat: fs.Stats }> {
  if (!fs.existsSync(root)) return [];
  const out: Array<{ file: string; stat: fs.Stats }> = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /\.log(?:\.\d+)?$/i.test(entry.name)) out.push({ file, stat: fs.statSync(file) });
    }
  };
  visit(root);
  return out;
}

export function rotateLogFile(file: string, incomingBytes: number, settings: LogSettings): boolean {
  if (!fs.existsSync(file)) return false;
  const maximum = settings.max_file_size_mb * 1024 * 1024;
  if (fs.statSync(file).size + incomingBytes <= maximum) return false;
  for (let index = settings.rotation_files; index >= 1; index -= 1) {
    const current = index === 1 ? file : `${file}.${index - 1}`;
    const next = `${file}.${index}`;
    if (!fs.existsSync(current)) continue;
    if (index === settings.rotation_files) fs.rmSync(next, { force: true });
    fs.renameSync(current, next);
  }
  return true;
}

export function enforceLogRetention(
  logDir: string,
  settings: LogSettings,
  skipFiles: ReadonlySet<string> = new Set()
): { deleted: number; freed_bytes: number } {
  const files = walkLogFiles(logDir);
  const now = Date.now();
  const cutoff = settings.retention_days > 0 ? now - settings.retention_days * 24 * 60 * 60 * 1000 : 0;
  let deleted = 0;
  let freed = 0;
  const remove = (item: { file: string; stat: fs.Stats }): void => {
    if (skipFiles.has(path.resolve(item.file)) || !fs.existsSync(item.file)) return;
    fs.rmSync(item.file, { force: true });
    deleted += 1;
    freed += item.stat.size;
  };
  if (cutoff) {
    for (const item of files) {
      if (item.stat.mtimeMs < cutoff) remove(item);
    }
  }
  const remaining = files.filter(item => fs.existsSync(item.file)).sort((left, right) => left.stat.mtimeMs - right.stat.mtimeMs);
  const maximumTotal = settings.max_total_size_mb * 1024 * 1024;
  let total = remaining.reduce((sum, item) => sum + item.stat.size, 0);
  for (const item of remaining) {
    if (total <= maximumTotal) break;
    if (skipFiles.has(path.resolve(item.file))) continue;
    remove(item);
    total -= item.stat.size;
  }
  return { deleted, freed_bytes: freed };
}
