// app.ts — the HTTP server for the forge.
//
// Routes:
//   GET  /healthz                    -> {"ok":true} (no auth)
//   /api/v3/*                        -> REST v3 (rest.ts)
//   POST /api/graphql               -> GraphQL v4 (graphql.ts)
//   POST /mcp                       -> MCP JSON-RPC 2.0 (mcp.ts)
//   /{owner}/{repo}.git/*           -> git smart HTTP (git.ts)
//   anything else                   -> JSON 404
//
// Every reply carries X-GitHub-Request-Id. Everything except /healthz needs
// `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>` and answers 401 without it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isAuthorized, Store } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) reject(new Error('request body too large'));
      else resolve(Buffer.concat(chunks));
    });
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  response.end(text);
}

function sendRaw(response: ServerResponse, status: number, contentType: string, body: Buffer): void {
  response.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
  });
  response.end(body);
}

export function createApp(): Server {
  const store = new Store();
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const segments = url.pathname.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));
        const method = request.method ?? 'GET';
        const host = request.headers.host ?? 'localhost';

        // GET /healthz — the only unauthenticated route.
        if (segments.length === 1 && segments[0] === 'healthz') {
          if (method !== 'GET') {
            sendJson(response, 404, { message: 'Not Found' });
            return;
          }
          sendJson(response, 200, { ok: true });
          return;
        }

        if (!isAuthorized(request.headers.authorization)) {
          sendJson(response, 401, { message: 'Bad credentials' });
          return;
        }

        // REST v3.
        if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
          let body: unknown = null;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(request);
            if (raw.length > 0) {
              try {
                body = JSON.parse(raw.toString('utf8'));
              } catch {
                sendJson(response, 400, { message: 'Malformed JSON in request body' });
                return;
              }
            }
          }
          const result = handleRest(store, method, segments.slice(2), url.searchParams, body, host);
          if (result === null) {
            sendJson(response, 404, { message: 'Not Found' });
            return;
          }
          if (result.body === null) {
            response.writeHead(result.status, {
              'x-github-request-id': nextRequestId(),
              ...(result.headers ?? {}),
            });
            response.end();
            return;
          }
          sendJson(response, result.status, result.body, result.headers ?? {});
          return;
        }

        // GraphQL v4.
        if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
          if (method !== 'POST') {
            sendJson(response, 404, { message: 'Not Found' });
            return;
          }
          const raw = await readBody(request);
          let body: unknown = null;
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw.toString('utf8'));
            } catch {
              sendJson(response, 400, { message: 'Malformed JSON in request body' });
              return;
            }
          }
          const result = handleGraphQL(store, body);
          sendJson(response, result.status, result.body);
          return;
        }

        // MCP.
        if (segments.length === 1 && segments[0] === 'mcp') {
          if (method !== 'POST') {
            sendJson(response, 404, { message: 'Not Found' });
            return;
          }
          const raw = await readBody(request);
          let body: unknown;
          if (raw.length === 0) {
            body = {};
          } else {
            try {
              body = JSON.parse(raw.toString('utf8'));
            } catch {
              const result = handleMcp(store, undefined);
              sendJson(response, result.status, result.body);
              return;
            }
          }
          const result = handleMcp(store, body);
          if (result.body === null) {
            response.writeHead(result.status, { 'x-github-request-id': nextRequestId() });
            response.end();
            return;
          }
          sendJson(response, result.status, result.body);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        if (segments.length >= 2 && segments[1] !== undefined && segments[1].endsWith('.git')) {
          const owner = segments[0] as string;
          const repoName = (segments[1] as string).slice(0, -4);
          const tail = segments.slice(2);
          const raw = await readBody(request);
          const headers: Record<string, string | undefined> = {
            'git-protocol': request.headers['git-protocol'],
          };
          const result = handleGit(store, method, owner, repoName, tail, url.searchParams, headers, raw);
          if (result === null) {
            sendJson(response, 404, { message: 'Not Found' });
            return;
          }
          sendRaw(response, result.status, result.contentType, result.body);
          return;
        }

        sendJson(response, 404, { message: 'Not Found' });
      } catch (err) {
        if (!response.headersSent) {
          sendJson(response, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          response.end();
        }
      }
    })();
  });
  return server;
}
