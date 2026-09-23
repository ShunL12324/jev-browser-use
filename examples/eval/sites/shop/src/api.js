// Thin JSON client; the run is carried by the shop_run cookie.
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error ?? 'Request failed'), { data, status: res.status })
  return data
}
