export async function apiFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body || `HTTP ${res.status}`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return res.json() as Promise<T>;
  return res.text() as Promise<T>;
}
