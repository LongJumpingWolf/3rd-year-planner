// Copies the static app into public/ for static hosting (e.g. Vercel). No bundling needed.
import { cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('public', { recursive: true, force: true });
mkdirSync('public', { recursive: true });
for (const p of ['index.html', 'view.html', 'favicon.svg', 'manifest.webmanifest', 'sw.js', 'css', 'js']) {
  cpSync(p, `public/${p}`, { recursive: true });
}
console.log('Static site written to public/');
