import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve, sep } from 'node:path';

const app = fileURLToPath(new URL('../', import.meta.url));
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf' };
const port = Number(process.env.PORT || 4666);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
const server = createServer(async (req, res) => {
  if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405,{ Allow:'GET, HEAD' }).end(); return; }
  let path;
  try { path=decodeURIComponent(new URL(req.url,'http://localhost').pathname); } catch { res.writeHead(400).end(); return; }
  if (path.includes('\\') || path.includes('\0') || path.startsWith('//') || path.split('/').some(s=>s.startsWith('.'))) {res.writeHead(404).end(); return;}
  const managed=path.startsWith('/_business/');
  if (managed) path=path.slice('/_business'.length);
  else if(path.startsWith('/_viewer/')) path=path.slice('/_viewer'.length);
  const root=resolve(app,managed?'dist-business':'dist');
  if(path==='/')path='/index.html';
  try {
    const candidate=await realpath(resolve(root,'.'+path));
    if(!candidate.startsWith(root+sep) || !Object.hasOwn(types,extname(candidate))) {res.writeHead(404).end();return;}
    const body=await readFile(candidate);
    res.writeHead(200,{'Content-Type':types[extname(candidate)],'Content-Length':body.length,'Cache-Control':path.startsWith('/assets/')?'private, max-age=31536000, immutable':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(req.method==='HEAD'?undefined:body);
  } catch {res.writeHead(404).end();}
});
server.listen(port,process.env.HOST||'127.0.0.1');
