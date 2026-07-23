const assert = require("node:assert");
const { WebSocketFrameParser } = require("../dist/websocket");

function maskedFrame(opcode, payload, fin = true) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const header = body.length < 126
    ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | body.length])
    : Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, body.length >> 8, body.length & 0xff]);
  const encoded = Buffer.from(body.map((byte, index) => byte ^ mask[index % 4]));
  return Buffer.concat([header, mask, encoded]);
}

const messages = [];
const parser = new WebSocketFrameParser({ maxFrameSize: 1024, maxMessageSize: 2048 });
const first = maskedFrame(1, "hel", false);
const second = maskedFrame(0, "lo", true);
const joined = Buffer.concat([first, second]);
parser.push(joined.subarray(0, 3), (opcode, body) => messages.push([opcode, body.toString()]));
parser.push(joined.subarray(3), (opcode, body) => messages.push([opcode, body.toString()]));
assert.deepStrictEqual(messages, [[1, "hello"]]);

assert.throws(() => {
  const invalid = new WebSocketFrameParser();
  invalid.push(Buffer.from([0x81, 0x01, 0x41]), () => {});
}, /必须掩码/);

assert.throws(() => {
  const limited = new WebSocketFrameParser({ maxFrameSize: 4, maxMessageSize: 8 });
  limited.push(maskedFrame(1, "12345"), () => {});
}, /单帧超过限制/);

assert.throws(() => {
  const invalidControl = new WebSocketFrameParser();
  invalidControl.push(maskedFrame(9, "x", false), () => {});
}, /控制帧无效/);

console.log("WebSocket 帧检查通过：掩码、分片、帧限制和控制帧校验");
