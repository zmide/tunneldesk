import { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";

interface LogRouteDependencies {
  listLogs(): unknown;
  readLog(path: string): string;
  readRawLog(path: string): string;
  readLogWindow(path: string, options: Record<string, unknown>): Promise<unknown>;
  getLogSettings(): unknown;
  updateLogSettings(value: unknown): unknown;
  enforceConfiguredLogRetention(): unknown;
  deleteLogs(paths: unknown[]): unknown;
  readJson(request: IncomingMessage): Promise<any>;
  send(response: ServerResponse, status: number, data: unknown, headers?: Record<string, string>): void;
  sendJson(response: ServerResponse, data: unknown, status?: number): void;
}

export async function handleLogRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  dependencies: LogRouteDependencies
): Promise<boolean> {
  const method = request.method || "GET";
  if (method === "GET" && pathname === "/api/logs") {
    dependencies.sendJson(response, dependencies.listLogs());
    return true;
  }
  if (method === "GET" && pathname === "/api/logs/read") {
    const url = new URL(request.url || pathname, `http://${request.headers.host || "localhost"}`);
    const logPath = url.searchParams.get("path") || "";
    const raw = url.searchParams.get("raw") === "1";
    if (url.searchParams.get("download") === "1") {
      dependencies.send(response, 200, raw ? dependencies.readRawLog(logPath) : dependencies.readLog(logPath), {
        "Content-Type": "text/plain; charset=utf-8"
      });
      return true;
    }
    const result = await dependencies.readLogWindow(logPath, {
      raw,
      beforeOffset: url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined,
      limitBytes: Number(url.searchParams.get("limit") || 256 * 1024),
      query: url.searchParams.get("query") || "",
      contextLines: Number(url.searchParams.get("context") || 2),
      maxMatches: Number(url.searchParams.get("max_matches") || 50)
    });
    dependencies.sendJson(response, result);
    return true;
  }
  if (method === "GET" && pathname === "/api/logs/settings") {
    dependencies.sendJson(response, dependencies.getLogSettings());
    return true;
  }
  if (method === "PUT" && pathname === "/api/logs/settings") {
    dependencies.sendJson(response, dependencies.updateLogSettings(await dependencies.readJson(request)));
    return true;
  }
  if (method === "POST" && pathname === "/api/logs/cleanup") {
    dependencies.sendJson(response, dependencies.enforceConfiguredLogRetention());
    return true;
  }
  if (method === "POST" && pathname === "/api/logs/delete") {
    const data = await dependencies.readJson(request);
    dependencies.sendJson(response, dependencies.deleteLogs(Array.isArray(data.paths) ? data.paths : []));
    return true;
  }
  return false;
}
