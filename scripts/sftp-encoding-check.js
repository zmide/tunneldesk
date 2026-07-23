const assert = require("node:assert");
const iconv = require("iconv-lite");
const { decodeRemoteFilenameOutput, decodeRemoteText, encodeRemoteText, normalizeTextEncoding, remotePathOperand } = require("../dist/sftp");

const sample = "你好，TunnelDesk\r\n";
const samples = {
  shift_jis: "こんにちは、TunnelDesk\r\n",
  "euc-kr": "안녕하세요, TunnelDesk\r\n",
  latin1: "TunnelDesk café\r\n"
};
for (const encoding of ["utf8", "utf8bom", "gb18030", "gbk", "big5", "shift_jis", "euc-kr", "latin1"]) {
  const source = samples[encoding] || sample;
  const encoded = encodeRemoteText(source, encoding);
  const decoded = decodeRemoteText(encoded, encoding);
  assert.strictEqual(decoded.content, source, `${encoding} round trip`);
  assert.strictEqual(decoded.encoding, encoding);
}

const bom = encodeRemoteText(sample, "utf8bom");
assert.deepStrictEqual([...bom.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
assert.strictEqual(decodeRemoteText(bom, "auto").encoding, "utf8bom");
assert.strictEqual(decodeRemoteText(Buffer.from(sample, "utf8"), "auto").encoding, "utf8");
assert.strictEqual(decodeRemoteText(encodeRemoteText(sample, "gb18030"), "auto").encoding, "gb18030");
assert.throws(() => normalizeTextEncoding("unsupported"), /不支持/);

const filenameSample = "故障告警接口";
for (const encoding of ["utf8", "gb18030", "gbk", "big5"]) {
  const connection = { sftp_filename_encoding:encoding };
  assert.strictEqual(decodeRemoteFilenameOutput(connection, iconv.encode(filenameSample, encoding)), filenameSample, `${encoding} filename decode`);
}
const gbkOperand = remotePathOperand({ sftp_filename_encoding:"gbk" }, `目录/${filenameSample}`);
assert.match(gbkOperand, /printf '%b'/);
assert.ok(!gbkOperand.includes(filenameSample), "non-UTF-8 path is emitted as bytes");
assert.strictEqual(remotePathOperand({ sftp_filename_encoding:"utf8" }, "目录/a.txt"), "'目录/a.txt'");

console.log("SFTP 编码检查通过：文本 BOM/自动回退/8 种编码往返及文件名转码");
