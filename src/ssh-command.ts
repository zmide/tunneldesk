const { DEFAULT_EXTRA_ARGS }: { DEFAULT_EXTRA_ARGS: string } = require("./config");

export function splitArgs(text: unknown): string[] {
  if (!text) return [];
  const args: string[] = [];
  const expression = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(String(text)))) {
    args.push((match[1] ?? match[2] ?? match[3]).replace(/\\(["'])/g, "$1"));
  }
  return args;
}

export function effectiveExtraArgs(text: unknown): string[] {
  const args = splitArgs(text);
  const joined = args.join(" ").toLowerCase();
  const defaults = splitArgs(DEFAULT_EXTRA_ARGS);
  for (let index = 0; index < defaults.length; index += 1) {
    if (defaults[index] === "-o" && defaults[index + 1]) {
      const name = defaults[index + 1].split("=")[0].toLowerCase();
      if (!joined.includes(name)) args.push("-o", defaults[index + 1]);
    }
  }
  return args;
}
