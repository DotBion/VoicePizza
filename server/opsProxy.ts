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

export function attachRestoOpsProxy(app: Express) {
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
      if (length && !upstream.headers.get('content-encoding')) res.setHeader('content-length', length);
      if ((upstream.headers.get('content-type') || '').includes('text/event-stream')) {
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');
      }
      res.flushHeaders();

      if (!upstream.body || req.method === 'HEAD') {
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
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
