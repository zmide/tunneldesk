const crypto = require("node:crypto");

const DEFAULT_MAX_FRAME_SIZE = 1024 * 1024;
const DEFAULT_MAX_MESSAGE_SIZE = 2 * 1024 * 1024;

function websocketAccept(key) {
  return crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

function validateWebSocketUpgrade(req) {
  const key = String(req.headers["sec-websocket-key"] || "");
  const version = String(req.headers["sec-websocket-version"] || "");
  const upgrade = String(req.headers.upgrade || "").toLowerCase();
  if (!key || version !== "13" || upgrade !== "websocket") throw new Error("WebSocket 握手无效");
  return key;
}

function sendWebSocketFrame(socket, data, opcode = 1) {
  if (socket.destroyed || socket.writableEnded || socket.writableDestroyed || (socket._tunneldeskClosing && opcode !== 8)) return false;
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  try {
    socket.write(Buffer.concat([header, payload]));
    return true;
  } catch {
    return false;
  }
}

function closeWebSocket(socket, code = 1000, reason = "") {
  if (socket.destroyed || socket.writableEnded || socket.writableDestroyed || socket._tunneldeskClosing) return;
  socket._tunneldeskClosing = true;
  const reasonBytes = Buffer.from(String(reason || ""), "utf8").subarray(0, 123);
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  try { sendWebSocketFrame(socket, payload, 8); } catch {}
  try { if (!socket.destroyed && !socket.writableEnded) socket.end(); } catch {}
}

class WebSocketFrameParser {
  pending = Buffer.alloc(0);
  fragmentOpcode = null;
  fragments = [];
  fragmentLength = 0;
  maxFrameSize;
  maxMessageSize;

  constructor(options: any = {}) {
    this.maxFrameSize = Number(options.maxFrameSize || DEFAULT_MAX_FRAME_SIZE);
    this.maxMessageSize = Number(options.maxMessageSize || DEFAULT_MAX_MESSAGE_SIZE);
  }

  push(chunk, onFrame) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    if (this.pending.length + chunk.length > this.maxMessageSize + 14) throw new Error("WebSocket 缓冲区超过限制");
    this.pending = Buffer.concat([this.pending, chunk]);
    let offset = 0;
    while (offset + 2 <= this.pending.length) {
      const first = this.pending[offset];
      const second = this.pending[offset + 1];
      const fin = Boolean(first & 0x80);
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      if (rsv) throw new Error("WebSocket RSV 位无效");
      if (![0, 1, 2, 8, 9, 10].includes(opcode)) throw new Error("WebSocket 操作码无效");
      if (!masked) throw new Error("客户端 WebSocket 数据帧必须掩码");

      let length = second & 0x7f;
      let headerLength = 2;
      if (length === 126) {
        if (offset + 4 > this.pending.length) break;
        length = this.pending.readUInt16BE(offset + 2);
        headerLength = 4;
      } else if (length === 127) {
        if (offset + 10 > this.pending.length) break;
        const value = this.pending.readBigUInt64BE(offset + 2);
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket 数据帧过大");
        length = Number(value);
        headerLength = 10;
      }
      const control = opcode >= 8;
      if (control && (!fin || length > 125)) throw new Error("WebSocket 控制帧无效");
      if (length > this.maxFrameSize) throw new Error("WebSocket 单帧超过限制");
      const frameEnd = offset + headerLength + 4 + length;
      if (frameEnd > this.pending.length) break;
      const mask = this.pending.subarray(offset + headerLength, offset + headerLength + 4);
      const source = this.pending.subarray(offset + headerLength + 4, frameEnd);
      const payload = Buffer.allocUnsafe(length);
      for (let index = 0; index < length; index += 1) payload[index] = source[index] ^ mask[index % 4];
      offset = frameEnd;
      this.consume(fin, opcode, payload, onFrame);
    }
    this.pending = this.pending.subarray(offset);
  }

  consume(fin, opcode, payload, onFrame) {
    if (opcode >= 8) {
      onFrame(opcode, payload);
      return;
    }
    if (opcode === 0) {
      if (this.fragmentOpcode === null) throw new Error("WebSocket 延续帧缺少起始帧");
      this.fragmentLength += payload.length;
      if (this.fragmentLength > this.maxMessageSize) throw new Error("WebSocket 消息超过限制");
      this.fragments.push(payload);
      if (fin) {
        const complete = Buffer.concat(this.fragments, this.fragmentLength);
        const originalOpcode = this.fragmentOpcode;
        this.fragmentOpcode = null;
        this.fragments = [];
        this.fragmentLength = 0;
        onFrame(originalOpcode, complete);
      }
      return;
    }
    if (this.fragmentOpcode !== null) throw new Error("WebSocket 分片消息尚未结束");
    if (payload.length > this.maxMessageSize) throw new Error("WebSocket 消息超过限制");
    if (fin) {
      onFrame(opcode, payload);
      return;
    }
    this.fragmentOpcode = opcode;
    this.fragments = [payload];
    this.fragmentLength = payload.length;
  }
}

module.exports = {
  WebSocketFrameParser,
  closeWebSocket,
  sendWebSocketFrame,
  validateWebSocketUpgrade,
  websocketAccept
};
