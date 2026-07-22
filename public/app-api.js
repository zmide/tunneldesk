async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (res.status === 401) {
    location.href = "/login";
    throw new Error("请先登录");
  }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
