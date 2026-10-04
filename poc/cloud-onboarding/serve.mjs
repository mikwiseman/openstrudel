import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const root = new URL('./', import.meta.url);
const files = new Map([['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
  ['/style.css', ['style.css', 'text/css']], ['/preview.mjs', ['preview.mjs', 'text/javascript']], ['/flow.mjs', ['flow.mjs', 'text/javascript']]]);
const server = createServer(async (request, response) => {
  const entry = files.get(new URL(request.url, 'http://localhost').pathname);
  if (request.method !== 'GET' || !entry) { response.writeHead(404); response.end(); return; }
  try {
    const body = await readFile(new URL(entry[0], root));
    response.writeHead(200, { 'Content-Type': `${entry[1]}; charset=utf-8`, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
    response.end(body);
  } catch { response.writeHead(500); response.end(); }
});
server.listen(0, '127.0.0.1', () => console.log(`Preview: http://127.0.0.1:${server.address().port}`));
