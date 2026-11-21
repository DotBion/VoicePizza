import type { Express, Request, Response } from 'express';
import { Readable } from 'node:stream';

/**
 * Same-origin proxy for the resto-ops backend (FastAPI `backend.app.main`, Queue Monitor + ops timeline).
 * The browser calls /api/ops/* and we forward to RESTO_OPS_BACKEND_URL/api/*. Only the endpoints the
 * Floor Monitor screen uses are allowed. Request bodies (JSON, multipart video, JPEG camera frames) are
 * streamed through untouched, Range requests work for video playback, and the SSE event feed is streamed
 * back chunk by chunk.
 */
const DEFAULT_RESTO_OPS_BACKEND = 'https://potter-computational-ability-backup.trycloudflare.com';
const ID = '[A-Za-z0-9_-]{1,80}';

const ROUTES: Array<{ method: 'GET' | 'POST'; pattern: RegExp }> = [
  { method: 'GET', pattern: /^health$/ },
  { method: 'GET', pattern: /^config$/ },
  { method: 'GET', pattern: /^timeline$/ },
  { method: 'GET', pattern: /^sources$/ },
  { method: 'POST', pattern: /^sources$/ },
  { method: 'GET', pattern: new RegExp(`^sources/${ID}/video$`) },
  { method: 'GET', pattern: new RegExp(`^sources/${ID}/frames/\\d{1,9}$`) },
  { method: 'GET', pattern: /^runs$/ },
  { method: 'POST', pattern: /^runs$/ },
  { method: 'POST', pattern: new RegExp(`^runs/${ID}/(advance|frame|stop)$`) },
  { method: 'POST', pattern: new RegExp(`^runs/${ID}/tasks/${ID}/acknowledge$`) },
  { method: 'GET', pattern: new RegExp(`^runs/${ID}/events$`) },
];

const FORWARD_REQUEST_HEADERS = ['content-type', 'content-length', 'range', 'last-event-id', 'accept'];
const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'content-range',
  'accept-ranges',
  'cache-control',
  'last-modified',
  'etag',
];

export function restoOpsBackendUrl(): string {
  return (process.env.RESTO_OPS_BACKEND_URL || DEFAULT_RESTO_OPS_BACKEND).replace(/\/+$/, '');
}

const POLL_WINDOW_MS = 1500;

/** Parse complete SSE frames (`id:` / `data:` lines separated by a blank line). */
function parseSse(text: string): Array<{ id: number; data: unknown }> {
  const out: Array<{ id: number; data: unknown }> = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    let id: number | null = null;
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('id:')) id = Number(line.slice(3).trim());
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (id === null || !Number.isFinite(id) || !data.length) continue;
    try {
      out.push({ id, data: JSON.parse(data.join('\n')) });
    } catch {
      /* incomplete frame at the cut-off; it will be returned by the next poll */
    }
  }
  return out;
}

export function attachRestoOpsProxy(app: Express) {
  /**
   * Polling fallback for hosts whose front proxy buffers or drops text/event-stream (e.g. AI Studio).
   * Reads the backend SSE feed for at most ~1.5 s, starting after `after` (backend honours Last-Event-ID),
   * and returns the complete events as JSON.
   */
  app.get(new RegExp(`^/api/ops/runs/(${ID})/poll$`), async (req: Request, res: Response) => {
    const runId = (req.params as unknown as string[])[0];
    const after = Math.max(0, Math.floor(Number(req.query.after ?? 0)) || 0);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POLL_WINDOW_MS);
    let text = '';
    try {
      const upstream = await fetch(`${restoOpsBackendUrl()}/api/runs/${runId}/events`, {
        headers: { accept: 'text/event-stream', 'last-event-id': String(after) },
        signal: controller.signal,
      });
      if (!upstream.ok || !upstream.body) {
        const body = await upstream.text().catch(() => '');
        clearTimeout(timer);
        res.status(upstream.status).type('application/json').send(body || JSON.stringify({ detail: 'Run not found.' }));
        return;
      }
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
      } catch {
        /* window elapsed: abort is the normal way out */
      }
    } catch (err) {
      clearTimeout(timer);
      if (!controller.signal.aborted) {
        const message = err instanceof Error ? err.message : 'unreachable';
        res.status(502).json({ detail: `Restaurant ops backend is offline (${message}).` });
        return;
      }
    }
    clearTimeout(timer);
    const lastComplete = Math.max(text.lastIndexOf('\n\n'), text.lastIndexOf('\r\n\r\n'));
    const events = parseSse(lastComplete >= 0 ? text.slice(0, lastComplete) : '')
      .filter((e) => e.id > after)
      .map((e) => e.data);
    const ids = events.map((e) => Number((e as { id?: number }).id) || 0);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ events, last_id: ids.length ? Math.max(after, ...ids) : after });
  });

  // Registered before express.json so request bodies are forwarded untouched.
  app.all(/^\/api\/ops\/(.+)$/, async (req: Request, res: Response) => {
    const subpath = req.path.replace(/^\/api\/ops\//, '');
    const matches = ROUTES.filter((r) => r.pattern.test(subpath));
    if (!matches.length) {
      res.status(404).json({ detail: `Unknown resto-ops endpoint: ${subpath}` });
      return;
    }
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    if (!matches.some((r) => r.method === method)) {
      res.status(405).json({ detail: `Method ${req.method} not allowed for /api/ops/${subpath}` });
      return;
    }

    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    try {
      const headers: Record<string, string> = {};
      for (const name of FORWARD_REQUEST_HEADERS) {
        const value = req.headers[name];
        if (typeof value === 'string' && value) headers[name] = value;
      }
      const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      const hasBody = method === 'POST';
      const upstream = await fetch(`${restoOpsBackendUrl()}/api/${subpath}${query}`, {
        method,
        headers,
        body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
        signal: controller.signal,
        redirect: 'manual',
        ...(hasBody ? { duplex: 'half' } : {}),
      } as RequestInit);

      res.status(upstream.status);
      for (const name of FORWARD_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      const length = upstream.headers.get('content-length');
      const isSse = (upstream.headers.get('content-type') || '').includes('text/event-stream');
      if (length && !upstream.headers.get('content-encoding') && !isSse) res.setHeader('content-length', length);
      let keepalive: NodeJS.Timeout | null = null;
      if (isSse) {
        // Defeat buffering/compressing front proxies: no-transform, identity encoding, early bytes, heartbeats.
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('Content-Encoding', 'identity');
        res.setHeader('Connection', 'keep-alive');
        req.socket.setNoDelay(true);
        req.socket.setTimeout(0);
      }
      res.flushHeaders();
      if (isSse) {
        res.write(':ok\n\n');
        keepalive = setInterval(() => res.write(':keepalive\n\n'), 10_000);
        res.on('close', () => keepalive && clearInterval(keepalive));
      }

      if (!upstream.body || req.method === 'HEAD') {
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
        (res as unknown as { flush?: () => void }).flush?.();
      }
      if (keepalive) clearInterval(keepalive);
      res.end();
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : 'unreachable';
      if (!res.headersSent) {
        res.status(502).json({ detail: `Restaurant ops backend is offline (${message}).` });
      } else {
        res.end();
      }
    }
  });
}
