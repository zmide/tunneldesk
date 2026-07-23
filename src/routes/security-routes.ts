import { IncomingMessage, ServerResponse } from "node:http";

interface SecurityRouteDependencies {
  AuthenticationError: new (...args: any[]) => Error;
  readJson(request: IncomingMessage): Promise<any>;
  send(response: ServerResponse, status: number, data: unknown, headers?: Record<string, string>): void;
  sendJson(response: ServerResponse, data: unknown, status?: number): void;
  publicSecuritySettings(request: IncomingMessage): unknown;
  login(password: string, request: IncomingMessage): string;
  logout(request: IncomingMessage): void;
  sessionCookie(request: IncomingMessage, token: string, maxAgeSeconds?: number): string;
  updateSecurityOptions(value: unknown): unknown;
  setPassword(password: string): void;
  createSession(): string;
  setToken(): string;
  enableEncryption(password: string): unknown;
  unlockEncryption(password: string): unknown;
  disableEncryption(): unknown;
  readSecuritySettings(): any;
  encryptStoredConnectionSecrets(): number;
  decryptStoredConnectionSecrets(): number;
}

export async function handlePublicAuthRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  dependencies: SecurityRouteDependencies
): Promise<boolean> {
  if (request.method === "GET" && pathname === "/api/auth/status") {
    dependencies.sendJson(response, dependencies.publicSecuritySettings(request));
    return true;
  }
  if (request.method !== "POST" || pathname !== "/api/auth/login") return false;
  const data = await dependencies.readJson(request);
  try {
    const token = dependencies.login(String(data.password || ""), request);
    dependencies.send(response, 200, { ok: true }, { "Set-Cookie": dependencies.sessionCookie(request, token) });
  } catch (error) {
    if (!(error instanceof dependencies.AuthenticationError)) throw error;
    const authenticationError = error as Error & { retryAfterSeconds?: number; statusCode?: number };
    const headers: Record<string, string> = authenticationError.retryAfterSeconds
      ? { "Retry-After": String(authenticationError.retryAfterSeconds) }
      : {};
    dependencies.send(response, authenticationError.statusCode || 401, { error: authenticationError.message }, headers);
  }
  return true;
}

export async function handleSecurityRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  dependencies: SecurityRouteDependencies
): Promise<boolean> {
  if (request.method === "POST" && pathname === "/api/auth/logout") {
    dependencies.logout(request);
    dependencies.send(response, 200, { ok: true }, { "Set-Cookie": dependencies.sessionCookie(request, "", 0) });
    return true;
  }
  if (request.method === "GET" && pathname === "/api/security") {
    dependencies.sendJson(response, dependencies.publicSecuritySettings(request));
    return true;
  }
  if (request.method === "PUT" && pathname === "/api/security") {
    dependencies.sendJson(response, dependencies.updateSecurityOptions(await dependencies.readJson(request)));
    return true;
  }
  if (request.method === "POST" && pathname === "/api/security/password") {
    const data = await dependencies.readJson(request);
    dependencies.setPassword(String(data.password || ""));
    const token = dependencies.createSession();
    dependencies.send(response, 200, dependencies.publicSecuritySettings(request), {
      "Set-Cookie": dependencies.sessionCookie(request, token)
    });
    return true;
  }
  if (request.method === "POST" && pathname === "/api/security/token") {
    const token = dependencies.setToken();
    dependencies.sendJson(response, { ...(dependencies.publicSecuritySettings(request) as object), token });
    return true;
  }
  if (request.method === "POST" && pathname === "/api/security/encryption/enable") {
    const data = await dependencies.readJson(request);
    const result = dependencies.enableEncryption(String(data.password || ""));
    const encrypted_rows = dependencies.encryptStoredConnectionSecrets();
    dependencies.sendJson(response, { ...(result as object), encrypted_rows });
    return true;
  }
  if (request.method === "POST" && pathname === "/api/security/encryption/unlock") {
    dependencies.sendJson(response, dependencies.unlockEncryption(String((await dependencies.readJson(request)).password || "")));
    return true;
  }
  if (request.method === "POST" && pathname === "/api/security/encryption/disable") {
    const data = await dependencies.readJson(request);
    const settings = dependencies.readSecuritySettings();
    if (settings.encryption_enabled) dependencies.unlockEncryption(String(data.password || ""));
    const decrypted_rows = settings.encryption_enabled ? dependencies.decryptStoredConnectionSecrets() : 0;
    const result = dependencies.disableEncryption();
    dependencies.sendJson(response, { ...(result as object), decrypted_rows });
    return true;
  }
  return false;
}
