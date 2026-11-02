import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('./dist/', import.meta.url));
const port = Number(process.argv[2] || 4177);
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.json':'application/json'};
const server = http.createServer(async (req,res) => {
  if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  try {
    const url = new URL(req.url,'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!path.startsWith(resolve(root)+sep)) { res.writeHead(403); res.end(); return; }
    if (!(await stat(path)).isFile()) throw new Error('not a file');
    const data = await readFile(path);
    res.writeHead(200, {'Content-Type':mime[extname(path)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; font-src 'self'; frame-ancestors 'self'; base-uri 'self'"});
    res.end(req.method==='HEAD'?undefined:data);
  } catch { res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}); res.end('Page not found'); }
});
server.listen(port,'127.0.0.1',()=>console.log(`Renew Before demo: http://127.0.0.1:${port}`));
