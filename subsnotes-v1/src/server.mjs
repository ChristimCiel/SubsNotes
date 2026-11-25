/**
 * Simple development server for SubsNotes v1 MVP
 */

import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 4199;

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

async function serve(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  
  // Remove query string
  filePath = filePath.split('?')[0];
  
  // Serve from public/ or src/ based on path
  let basePath;
  if (filePath.startsWith('/src/')) {
    basePath = join(__dirname, '..');
  } else {
    basePath = join(__dirname, '..', 'public');
  }
  
  const fullPath = join(basePath, filePath);
  
  try {
    const stats = await stat(fullPath);
    
    if (stats.isDirectory()) {
      res.writeHead(404);
      res.end('Directory listing not supported');
      return;
    }
    
    const content = await readFile(fullPath);
    const ext = extname(fullPath);
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
    
    res.writeHead(200, {
      'Content-Type': mimeType,
      'Access-Control-Allow-Origin': '*'
    });
    res.end(content);
    
    console.log(`✓ ${req.method} ${req.url} → ${mimeType}`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.writeHead(404);
      res.end('Not found');
      console.log(`✗ ${req.method} ${req.url} → 404`);
    } else {
      res.writeHead(500);
      res.end('Server error');
      console.error(`✗ ${req.method} ${req.url} →`, error.message);
    }
  }
}

const server = createServer(serve);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🚀 SubsNotes v1 MVP Server`);
  console.log(`📍 http://127.0.0.1:${PORT}`);
  console.log(`📝 Judge Mode: http://127.0.0.1:${PORT}/judge.html`);
  console.log(`🎭 Demo Site: http://127.0.0.1:${PORT}/fictional-merchant.html\n`);
  console.log(`Press Ctrl+C to stop\n`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try a different port with PORT=XXXX npm run dev`);
  } else {
    console.error('Server error:', error);
  }
  process.exit(1);
});
