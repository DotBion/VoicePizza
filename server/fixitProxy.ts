import type { Express, Request, Response } from 'express';
import { Readable } from 'node:stream';

/**
 * Same-origin proxy for the Fix-It Cam backend (FastAPI, see DotBion/fixitcam).
 * The backend sends no CORS headers, so the browser talks to /api/fixit/* here and we forward
 * to FIXIT_BACKEND_URL, streaming multipart uploads up and NDJSON progress events back down.
 */
const DEFAULT_FIXIT_BACKEND = 'https://bradley-bookmarks-rice-late.trycloudflare.com';
const ALLOWED = new Map<string, 'GET' | 'POST'>([
  ['health', 'GET'],
  ['analyze', 'POST'],
  ['checkout', 'POST'],
]);

export function fixitBackendUrl(): string {
  return (process.env.FIXIT_BACKEND_URL || DEFAULT_FIXIT_BACKEND).replace(/\/+$/, '');
}

export function attachFixItProxy(app: Express) {
  // Registered before express.json so request bodies are forwarded untouched.
  app.all('/api/fixit/:endpoint', async (req: Request, res: Response) => {
    const endpoint = req.params.endpoint;
    const method = ALLOWED.get(endpoint);
    if (!method) {
      res.status(404).json({ error: `Unknown Fix-It endpoint: ${endpoint}` });
      return;
    }
    if (req.method !== method) {
      res.status(405).json({ error: `Use ${method} for /api/fixit/${endpoint}` });
      return;
    }

    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    try {
      const headers: Record<string, string> = {};
      const contentType = req.headers['content-type'];
      if (contentType) headers['content-type'] = contentType;
      const contentLength = req.headers['content-length'];
      if (contentLength) headers['content-length'] = contentLength;

      const upstream = await fetch(`${fixitBackendUrl()}/api/${endpoint}`, {
        method,
        headers,
        body: method === 'POST' ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
        signal: controller.signal,
        // Required by Node's fetch when streaming a request body.
        ...(method === 'POST' ? { duplex: 'half' } : {}),
      } as RequestInit);

      res.status(upstream.status);
      const upstreamType = upstream.headers.get('content-type');
      if (upstreamType) res.setHeader('Content-Type', upstreamType);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      if (!upstream.body) {
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
      const message = err instanceof Error ? err.message : 'Fix-It backend unreachable';
      if (!res.headersSent) {
        res.status(502).json({ error: `Fix-It backend unreachable (${message}).` });
      } else {
        res.end();
      }
    }
  });
}
