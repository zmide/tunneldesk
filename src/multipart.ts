function parseMultipart(contentType, body) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!match) throw new Error("上传请求缺少 boundary");
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const parts = [];
  let offset = 0;
  while (true) {
    const start = body.indexOf(boundary, offset);
    if (start < 0) break;
    const next = body.indexOf(boundary, start + boundary.length);
    if (next < 0) break;
    let chunk = body.subarray(start + boundary.length, next);
    if (chunk.subarray(0, 2).toString() === "\r\n") chunk = chunk.subarray(2);
    if (chunk.subarray(0, 2).toString() === "--") break;
    const sep = chunk.indexOf(Buffer.from("\r\n\r\n"));
    if (sep < 0) {
      offset = next;
      continue;
    }
    const headerText = chunk.subarray(0, sep).toString("utf8");
    let data = chunk.subarray(sep + 4);
    if (data.subarray(-2).toString() === "\r\n") data = data.subarray(0, -2);
    const disposition = /content-disposition:\s*form-data;([^\r\n]+)/i.exec(headerText)?.[1] || "";
    const name = /name="([^"]+)"/i.exec(disposition)?.[1];
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1];
    if (name) parts.push({ name, filename, data });
    offset = next;
  }
  return parts;
}

function getPart(contentType, body, fieldName) {
  const part = parseMultipart(contentType, body).find((item) => item.name === fieldName);
  if (!part) throw new Error(`没有找到上传字段: ${fieldName}`);
  return part;
}

module.exports = { parseMultipart, getPart };
