// Tiny static server for the mock chat page (any GET -> index.html).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = +(process.env.MOCK_PORT || 8123);
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(root, 'index.html')));
}).listen(port, '127.0.0.1', () => console.log(`mock chat on http://127.0.0.1:${port}/`));
