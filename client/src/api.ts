/**
 * Cliente HTTP mínimo para /api. Lanza ApiError con el mensaje del servidor.
 * Si el servidor responde 401, emite el evento 'auth:required' en window para mostrar el login.
 * Toda petición POST/PUT/DELETE exitosa emite 'app:mutated' (lo usa el widget de cartera en main.ts
 * para refrescarse sin que cada vista tenga que saberlo).
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      window.dispatchEvent(new CustomEvent('auth:required'));
    }
    const err = (data as { error?: string; details?: unknown }) ?? {};
    throw new ApiError(res.status, err.error || `Error ${res.status}`, err.details);
  }
  if (method !== 'GET') window.dispatchEvent(new CustomEvent('app:mutated'));
  return data as T;
}

/** Construye un query string ignorando valores vacíos/undefined. */
export function qs(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
