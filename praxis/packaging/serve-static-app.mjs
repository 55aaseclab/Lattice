import { imageCacheHeaders, imageNotModified } from './image-cache.mjs';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4' };

export function createStaticAppServer({ root }) {
  return createServer(async (request, response) => {
    const end = (status, message) => { response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(request.method === 'HEAD' ? undefined : message); };
    if (!['GET', 'HEAD'].includes(request.method)) { response.setHeader('Allow', 'GET, HEAD'); return end(405, 'Method not allowed.'); }
    try {
      let path;
      try { path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); } catch { return end(400, 'Invalid path.'); }
      if (path.includes('\0') || path.includes('\\') || path.split('/').some(segment => segment.startsWith('.')) || /^\/@(?:fs|id|vite)(?:\/|$)/.test(path)) return end(404, 'Not found.');
      const base = await realpath(root);
      let file = await realpath(resolve(base, `.${path}`));
      if ((await stat(file)).isDirectory()) file = await realpath(resolve(file, 'index.html'));
      const within = relative(base, file);
      if (within === '..' || within.startsWith(`..${sep}`) || within.startsWith(sep)) return end(404, 'Not found.');
      const info = await stat(file);
      if (!info.isFile()) return end(404, 'Not found.');
      const type = types[extname(file).toLowerCase()] || 'application/octet-stream';
      const headers = imageCacheHeaders(type, info);
      if (imageNotModified(request, headers)) {
        response.writeHead(304, { ...headers, 'X-Content-Type-Options': 'nosniff' });
        return response.end();
      }
      let start = 0, finish = info.size - 1, status = 200;
      if (request.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
        if (!match || (!match[1] && !match[2]) || !info.size) { response.setHeader('Content-Range', `bytes */${info.size}`); return end(416, 'Invalid range.'); }
        if (match[1]) { start = Number(match[1]); finish = match[2] ? Math.min(Number(match[2]), finish) : finish; }
        else start = Math.max(0, info.size - Number(match[2]));
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(finish) || start > finish || start >= info.size) { response.setHeader('Content-Range', `bytes */${info.size}`); return end(416, 'Invalid range.'); }
        status = 206;
        response.setHeader('Content-Range', `bytes ${start}-${finish}/${info.size}`);
      }
      response.writeHead(status, { 'Content-Type': type, 'Content-Length': info.size ? finish - start + 1 : 0, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache', ...headers });
      if (request.method === 'HEAD' || !info.size) return response.end();
      createReadStream(file, { start, end: finish }).on('error', () => response.destroy()).pipe(response);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return end(404, 'Not found.');
      return end(500, 'Unable to read static content.');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { root: { type: 'string' }, port: { type: 'string' }, host: { type: 'string', default: '0.0.0.0' } } });
  const port = Number(values.port);
  if (!values.root || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Provide --root and a valid --port.');
  const server = createStaticAppServer({ root: resolve(values.root) });
  server.on('error', error => { console.error(`Static app failed: ${error.message}`); process.exitCode = 1; });
  server.listen(port, values.host, () => console.log(`Static app listening on http://${values.host}:${port}`));
}
