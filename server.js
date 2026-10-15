// Zero-dependency static file server for local use: `npm start` -> http://localhost:3000
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT) || 3000;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
};
// Only the app itself is served; tests, node_modules and the legacy copy are not.
const PUBLIC = ['index.html', 'view.html', 'favicon.svg', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'supabase'];

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = resolve(join(ROOT, normalize(path)));
      const rel = file.slice(ROOT.length + 1);
      const allowed = file.startsWith(ROOT + sep) && PUBLIC.some((p) => rel === p || rel.startsWith(p + sep));
      if (!allowed) return send(res, 404, 'Not found');
      if (!(await stat(file)).isFile()) return send(res, 404, 'Not found');
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(body);
    } catch {
      send(res, 404, 'Not found');
    }
  });
}

function send(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, () => {
    console.log(`MBBS Study Command Center running at http://localhost:${PORT}`);
  });
}
