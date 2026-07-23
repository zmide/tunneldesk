import iconv from "iconv-lite";
import { TextDecoder } from "node:util";

const FILENAME_ENCODINGS = new Set(["utf8", "gb18030", "gbk", "big5", "shift_jis", "euc-kr", "latin1"]);
const TEXT_ENCODINGS = new Set(["auto", "utf8", "utf8bom", "gb18030", "gbk", "big5", "shift_jis", "euc-kr", "latin1"]);

interface SftpEncodingConnection {
  sftp_filename_encoding?: string | null;
}

export function shellQuote(value: unknown): string {
  return `'${String(value || "").replace(/'/g, `'\\''`)}'`;
}

export function filenameEncoding(connection: SftpEncodingConnection | null | undefined): string {
  const encoding = String(connection?.sftp_filename_encoding || "utf8").toLowerCase();
  return FILENAME_ENCODINGS.has(encoding) ? encoding : "utf8";
}

export function remotePathOperand(connection: SftpEncodingConnection | null | undefined, value: unknown): string {
  const text = String(value || "");
  const encoding = filenameEncoding(connection);
  if (encoding === "utf8") return shellQuote(text);
  const bytes = iconv.encode(text, encoding);
  if (iconv.decode(bytes, encoding) !== text) throw new Error(`文件名包含 ${encoding} 无法表示的字符`);
  const octal = [...bytes].map(byte => `\\0${byte.toString(8).padStart(3, "0")}`).join("");
  return `"$(printf '%b' ${shellQuote(octal)})"`;
}

export function decodeRemoteFilenameOutput(connection: SftpEncodingConnection | null | undefined, body: Buffer): string {
  return iconv.decode(body, filenameEncoding(connection));
}

export function normalizeTextEncoding(value: unknown, fallback = "auto"): string {
  const encoding = String(value || fallback || "auto").toLowerCase();
  if (!TEXT_ENCODINGS.has(encoding)) throw new Error("不支持的文本编码");
  return encoding;
}

export function decodeRemoteText(body: Buffer, requestedEncoding = "auto"): {
  content: string;
  encoding: string;
  bom: boolean;
} {
  let encoding = normalizeTextEncoding(requestedEncoding);
  const hasUtf8Bom = body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf;
  if (encoding === "auto") {
    if (hasUtf8Bom) encoding = "utf8bom";
    else {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(body);
        encoding = "utf8";
      } catch {
        encoding = "gb18030";
      }
    }
  }
  const source = encoding === "utf8bom" && hasUtf8Bom ? body.subarray(3) : body;
  const content = iconv.decode(source, encoding === "utf8bom" ? "utf8" : encoding);
  return { content, encoding, bom: encoding === "utf8bom" && hasUtf8Bom };
}

export function encodeRemoteText(content: unknown, encoding: unknown): Buffer {
  const selected = normalizeTextEncoding(encoding, "utf8");
  if (selected === "auto") throw new Error("保存文件前请选择明确的文本编码");
  const text = String(content || "");
  const codec = selected === "utf8bom" ? "utf8" : selected;
  const body = iconv.encode(text, codec);
  if (iconv.decode(body, codec) !== text) throw new Error(`当前内容包含 ${selected} 无法表示的字符，请改用 UTF-8 或其他编码`);
  return selected === "utf8bom" ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}
