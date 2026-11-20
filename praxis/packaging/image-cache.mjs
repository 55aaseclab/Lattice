import { createHash } from 'node:crypto';

export function imageCacheHeaders(type, info, { mutable = false } = {}) {
  if (!/^image\//i.test(type)) return null;
  const identity = [info.size, info.mtimeMs, info.ctimeMs, info.ino, type].join(':');
  const digest = createHash('sha256').update(identity).digest('hex');
  return {
    'Content-Type': type,
    'Cache-Control': mutable ? 'private, no-cache, must-revalidate' : 'private, max-age=3600, must-revalidate',
    ETag: `W/"${digest}"`,
    'Last-Modified': info.mtime.toUTCString(),
    Vary: 'Authorization',
  };
}

export function imageNotModified(request, headers) {
  if (!headers || !['GET', 'HEAD'].includes(request.method)) return false;
  const supplied = request.headers['if-none-match'];
  if (supplied !== undefined) {
    const value = String(supplied).trim();
    if (value === '*') return true;
    const tags = value.match(/(?:W\/)?"[^"\r\n]*"/g) || [];
    return tags.some(tag => tag.replace(/^W\//, '') === headers.ETag.replace(/^W\//, ''));
  }
  const since = Date.parse(request.headers['if-modified-since'] || '');
  return Number.isFinite(since) && Date.parse(headers['Last-Modified']) <= since;
}
