import { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";

interface UpdateCheckerLike {
  packageInfo: { version?: string };
  status(): unknown;
  check(options: { force: boolean }): Promise<unknown>;
  setIgnoredCurrentVersion(enabled: boolean): unknown;
}

interface UpdateInstallerLike {
  status(release?: any): unknown;
  download(release: any): Promise<unknown>;
  verifyDownloaded(release?: any): Promise<any>;
}

interface UpdateRouteDependencies {
  checker: UpdateCheckerLike;
  installer: UpdateInstallerLike;
  sendJson(response: ServerResponse, data: unknown, status?: number): void;
  isLocalRequest(request: IncomingMessage): boolean;
  canOpenPackage(): boolean;
  canOpenDirectory(): boolean;
  openPackage(file: string): Promise<unknown>;
  openDirectory(file: string): Promise<unknown>;
}

export async function handleUpdateRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  dependencies: UpdateRouteDependencies
): Promise<boolean> {
  const { checker, installer, sendJson } = dependencies;
  if (request.method === "GET" && pathname === "/api/updates/status") {
    sendJson(response, checker.status() || {
      current_version: String(checker.packageInfo.version || "").replace(/^v/i, ""),
      latest_version: "",
      update_available: false,
      checked_at: "",
      from_cache: true,
      source: "github"
    });
    return true;
  }
  if (request.method === "GET" && pathname === "/api/updates/check") {
    const url = new URL(request.url || pathname, `http://${request.headers.host || "localhost"}`);
    try {
      sendJson(response, await checker.check({ force: url.searchParams.get("force") === "1" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "检查更新失败，请稍后重试";
      sendJson(response, { error: message || "检查更新失败，请稍后重试" }, 502);
    }
    return true;
  }
  if (request.method === "POST" && pathname === "/api/updates/ignore") {
    const url = new URL(request.url || pathname, `http://${request.headers.host || "localhost"}`);
    const enabled = url.searchParams.get("enabled");
    if (!["0", "1"].includes(String(enabled))) {
      sendJson(response, { error: "忽略更新设置无效" }, 400);
      return true;
    }
    try {
      sendJson(response, checker.setIgnoredCurrentVersion(enabled === "1"));
    } catch (error) {
      sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 422);
    }
    return true;
  }
  if (request.method === "GET" && pathname === "/api/updates/download/status") {
    sendJson(response, {
      ...(installer.status(checker.status()) as object),
      can_open: dependencies.canOpenPackage(),
      can_open_directory: dependencies.canOpenDirectory()
    });
    return true;
  }
  if (request.method === "POST" && pathname === "/api/updates/download") {
    try {
      const release = await checker.check({ force: false });
      sendJson(response, {
        ...(await installer.download(release) as object),
        can_open: dependencies.canOpenPackage(),
        can_open_directory: dependencies.canOpenDirectory()
      });
    } catch (error) {
      sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 422);
    }
    return true;
  }
  if (request.method === "POST" && pathname === "/api/updates/open") {
    if (!dependencies.isLocalRequest(request) || !dependencies.canOpenPackage()) {
      sendJson(response, { error: "只能在本机桌面版中打开更新安装包" }, 403);
      return true;
    }
    try {
      const state = await installer.verifyDownloaded(checker.status());
      if (state.package_type === "portable") {
        throw new Error("便携版不会直接启动，请打开下载目录并在关闭旧版本后手动替换");
      }
      await dependencies.openPackage(String(state.file || ""));
      sendJson(response, { ok: true, state: "opened", version: state.version });
    } catch (error) {
      sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 422);
    }
    return true;
  }
  if (request.method === "POST" && pathname === "/api/updates/open-directory") {
    if (!dependencies.isLocalRequest(request) || !dependencies.canOpenDirectory()) {
      sendJson(response, { error: "只能在本机桌面版中打开更新下载目录" }, 403);
      return true;
    }
    try {
      const state = await installer.verifyDownloaded(checker.status());
      await dependencies.openDirectory(String(state.file || ""));
      sendJson(response, { ok: true, state: "directory_opened", version: state.version });
    } catch (error) {
      sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 422);
    }
    return true;
  }
  return false;
}
