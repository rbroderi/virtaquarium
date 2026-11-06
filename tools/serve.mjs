// Zero-dependency static server for the PC aquarium.
// Also accepts POST /__save?path=roku/... so the export page can write sprites to disk.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || process.argv[2] || 8080);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

export function startServer(port = PORT, onEvent = () => {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'POST' && url.pathname === '/__save') {
      const rel = url.searchParams.get('path') || '';
      const dest = path.resolve(ROOT, rel);
      // Only allow writing generated Roku assets, imported fish models, lab reference photos and check
      // output (out/, git-ignored).
      const allowed = [path.join(ROOT, 'roku'), path.join(ROOT, 'pc', 'models'), path.join(ROOT, 'pc', 'ref'), path.join(ROOT, 'out')].some((d) => dest.startsWith(d + path.sep));
      if (!allowed) { res.writeHead(403).end(); return; }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        // On Windows another process (a virus scan, a browser showing the old sheet) can hold the file
        // a moment: write beside it and swap it in, retrying, rather than take the server down.
        const tmp = dest + '.part';
        for (let tries = 0; ; tries++) {
          try {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(tmp, Buffer.concat(chunks));
            fs.renameSync(tmp, dest);
            break;
          } catch (err) {
            if (tries < 20) { await new Promise((r) => setTimeout(r, 250)); continue; }
            console.error(`save ${rel}: ${err.message}`);
            res.writeHead(500).end(err.message);
            return;
          }
        }
        onEvent({ type: 'saved', path: rel });
        res.writeHead(200).end('ok');
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/__done') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => { res.writeHead(200).end('ok'); onEvent({ type: 'done', body }); });
      return;
    }

    let p = decodeURIComponent(url.pathname);
    if (p === '/') { res.writeHead(302, { Location: '/pc/' }).end(); return; }
    let file = path.resolve(ROOT, '.' + p);
    // Never serve secrets (API keys) or dotfiles.
    if (!file.startsWith(ROOT) || /\.key$/i.test(file) || /[\\/]\./.test(file.slice(ROOT.length))) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      // js-profiling: lets a page sample itself (main.js ?profile=1, the JS Self-Profiling API).
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Document-Policy': 'js-profiling' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().then(() => console.log(`Virtual aquarium: http://localhost:${PORT}/pc/`));
}
