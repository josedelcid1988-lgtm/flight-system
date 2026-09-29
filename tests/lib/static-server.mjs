// Serves the repository over http://127.0.0.1 for browser tests that reload a page. Chromium can drop localStorage
// writes for file:// pages under parallel load, so a reload then finds empty storage; http:// pages do not.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

export async function serveRepo() {
  const server = http.createServer(async (request, response) => {
    const file = path.join(root, decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname));
    if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
    try {
      const body = await fs.readFile(file);
      response.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  return { url: relative => new URL(relative, base).href, close: () => new Promise(resolve => server.close(resolve)) };
}
