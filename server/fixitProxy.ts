import type { Express, Request, Response } from 'express';
import { Readable } from 'node:stream';
import { recordFixItCase } from './caseRecorder';

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

    // Every diagnosis becomes a Stress Lab "past case" (recorded on the ops backend, no media kept).
    const isAnalyze = endpoint === 'analyze';
    const startedMs = Date.now();
    const clipHeader = req.headers['x-fixit-clip'];
    let clip = 'clip';
    try {
      clip = typeof clipHeader === 'string' && clipHeader ? decodeURIComponent(clipHeader).slice(0, 120) : 'clip';
    } catch {
      /* keep default */
    }
    const bytes = Number(req.headers['content-length']) || null;
    const seen: Array<Record<string, unknown>> = [];
    let lineBuffer = '';
    const collect = (chunk: string) => {
      lineBuffer += chunk;
      let idx: number;
      while ((idx = lineBuffer.indexOf('\n')) >= 0) {
        const line = lineBuffer.slice(0, idx).trim();
        lineBuffer = lineBuffer.slice(idx + 1);
        if (!line) continue;
        try {
          seen.push(JSON.parse(line));
        } catch {
          /* not an event line */
        }
      }
    };
    const record = (extra: { transportError?: string | null; httpStatus?: number }) => {
      if (!isAnalyze) return;
      if (lineBuffer.trim()) collect('\n');
      void recordFixItCase({ events: seen, clip, bytes, startedMs, ...extra });
    };

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
        record({ httpStatus: upstream.status });
        return;
      }
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let errorBody = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
        if (isAnalyze) {
          const text = decoder.decode(value, { stream: true });
          if (upstream.status === 200) collect(text);
          else errorBody += text;
        }
      }
      res.end();
      if (upstream.status !== 200) {
        let detail: string | null = null;
        try {
          const j = JSON.parse(errorBody) as { detail?: unknown; error?: unknown };
          detail = String(j.detail || j.error || '') || null;
        } catch {
          /* not JSON */
        }
        record({ httpStatus: upstream.status, transportError: detail ? `HTTP ${upstream.status}: ${detail}` : null });
      } else {
        record({});
      }
    } catch (err) {
      if (controller.signal.aborted) {
        record({ transportError: 'Cancelled by the user before the diagnosis finished.' });
        return;
      }
      const message = err instanceof Error ? err.message : 'Fix-It backend unreachable';
      record({ transportError: `Fix-It backend unreachable (${message}).` });
      if (!res.headersSent) {
        res.status(502).json({ error: `Fix-It backend unreachable (${message}).` });
      } else {
        res.end();
      }
    }
  });
}
