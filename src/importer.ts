const path = require("node:path");
const { DEFAULT_EXTRA_ARGS } = require("./config");
const { validatePort, insertConnection, insertForward, listConnections } = require("./db");
const { testSsh } = require("./ssh");

function splitLine(line) {
  const out = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function identityName(value) {
  if (!value) return null;
  return path.basename(String(value).replace(/\\/g, "/").replace(/^["']|["']$/g, ""));
}

function parseHostPort(value, defaultHost = "127.0.0.1") {
  const raw = String(value).trim();
  if (raw.startsWith("[") && raw.includes("]:")) {
    const [host, port] = raw.slice(1).split("]:");
    return [host, validatePort(port, "端口")];
  }
  if (raw.includes(":")) {
    const idx = raw.lastIndexOf(":");
    return [raw.slice(0, idx) || defaultHost, validatePort(raw.slice(idx + 1), "端口")];
  }
  return [defaultHost, validatePort(raw, "端口")];
}

function parseForward(kind, args) {
  if (kind === "socks") {
    const [bind_host, bind_port] = parseHostPort(args[0], "127.0.0.1");
    return { mode: "socks", bind_host, bind_port, target_host: null, target_port: null };
  }
  const [bind_host, bind_port] = parseHostPort(args[0], "127.0.0.1");
  const [target_host, target_port] = parseHostPort(args[1], "127.0.0.1");
  return { mode: kind, bind_host, bind_port, target_host, target_port };
}

function parseConfigText(text) {
  const tunnels = [];
  let aliases = [];
  let current = null;
  function flush() {
    if (!current || !aliases.length || !current.forwards?.length) return;
    for (const alias of aliases) {
      if (alias.includes("*") || alias.includes("?")) continue;
      const keyName = identityName(current.identity_file);
      tunnels.push({
        name: alias,
        group_name: "导入",
        mode: current.forwards[0]?.mode || "local",
        ssh_host: current.hostname || alias,
        ssh_port: validatePort(current.port || 22, "SSH 端口"),
        ssh_user: current.user || "",
        identity_name: keyName,
        identity_file: null,
        missing_identity: Boolean(keyName),
        bind_host: current.forwards[0]?.bind_host || "127.0.0.1",
        bind_port: current.forwards[0]?.bind_port || null,
        target_host: current.forwards[0]?.target_host || "127.0.0.1",
        target_port: current.forwards[0]?.target_port || null,
        forwards: current.forwards,
        extra_args: DEFAULT_EXTRA_ARGS,
        autostart_forwards: 0,
        sort_order: 1,
        autostart: 0
      });
    }
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = splitLine(line);
    const key = parts.shift()?.toLowerCase();
    if (key === "host") {
      flush();
      aliases = parts;
      current = { forwards: [] };
    } else if (current && ["hostname", "user", "port"].includes(key)) {
      current[key] = parts[0];
    } else if (current && key === "identityfile") {
      current.identity_file = parts[0];
    } else if (current && key === "localforward") {
      current.forwards.push(parseForward("local", parts));
    } else if (current && key === "remoteforward") {
      current.forwards.push(parseForward("remote", parts));
    } else if (current && key === "dynamicforward") {
      current.forwards.push(parseForward("socks", parts));
    }
  }
  flush();
  const missing_keys = [...new Set(tunnels.filter((t) => t.missing_identity).map((t) => t.identity_name))].sort();
  return { filename: "config", count: tunnels.length, missing_keys, tunnels };
}

async function mapLimit(items, limit, mapper) {
  const result = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      result[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}

async function batchTest(tunnels) {
  const results = await mapLimit(tunnels, 4, async (item) => ({ name: item.name, ssh_host: item.ssh_host, ...(await testSsh(item)) }));
  const ok = results.filter((item) => item.ok).length;
  return { total: results.length, ok, failed: results.length - ok, results };
}

function saveImported(tunnels, defaultExtraArgs) {
  const ids = [];
  const errors = [];
  tunnels.forEach((item, index) => {
    try {
      const id = insertConnection(item, defaultExtraArgs);
      for (const forward of item.forwards || []) insertForward(id, forward);
      ids.push(id);
    } catch (error) {
      errors.push({ index: index + 1, name: item.name || "", error: error.message });
    }
  });
  return { saved: ids.length, ids, errors };
}

function exportConfig(ids) {
  const selected = ids?.length ? new Set(ids.map(Number)) : null;
  const lines = [];
  for (const conn of listConnections()) {
    if (selected && !selected.has(conn.id)) continue;
    lines.push(`Host ${conn.name}`);
    lines.push(`  HostName ${conn.ssh_host}`);
    lines.push(`  User ${conn.ssh_user}`);
    lines.push(`  Port ${conn.ssh_port}`);
    if (conn.identity_file) lines.push(`  IdentityFile ${conn.identity_file}`);
    for (const f of conn.forwards) {
      if (f.mode === "local") lines.push(`  LocalForward ${f.bind_host}:${f.bind_port} ${f.target_host}:${f.target_port}`);
      else if (f.mode === "remote") lines.push(`  RemoteForward ${f.bind_host}:${f.bind_port} ${f.target_host}:${f.target_port}`);
      else lines.push(`  DynamicForward ${f.bind_host}:${f.bind_port}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

module.exports = { parseConfigText, batchTest, saveImported, exportConfig };
