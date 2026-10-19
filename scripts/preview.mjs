import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
http.createServer(async (request, response) => {
  try {
    const path = resolve(root, `.${decodeURIComponent(new URL(request.url, 'http://localhost').pathname)}`);
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)
      || (!path.includes(`${sep}src${sep}content${sep}`) && !path.includes(`${sep}src${sep}shared${sep}`)
        && !path.includes(`${sep}tests${sep}fixtures${sep}`))) {
      response.writeHead(403).end();
      return;
    }
    const content = await readFile(path);
    response.writeHead(200, { 'Content-Type': `${types[extname(path)] ?? 'text/plain'}; charset=utf-8`,
      'Cache-Control': 'no-store' });
    response.end(content);
  } catch {
    response.writeHead(404).end();
  }
}).listen(4173, '127.0.0.1', () => {
  console.log('Preview: http://127.0.0.1:4173/tests/fixtures/queue.html');
});
