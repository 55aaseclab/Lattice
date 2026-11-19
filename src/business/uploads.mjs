import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const maximumBytes = 128 * 1024 * 1024, chunkBytes = 1024 * 1024;
const mimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/mp4']);
const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const now = store => store.now();
const partPath = (store, id) => join(store.blobs, '.uploads', `${id}.part`);
const uploadView = upload => ({ uploadId: upload.id, resourceId: upload.deckId, offset: upload.receivedBytes, receivedBytes: upload.receivedBytes, byteLength: upload.byteLength, chunkBytes, expiresAt: upload.expiresAt });

function ownedUpload(state, request, claims, store) {
  const upload = state.uploads?.[request.input.uploadId];
  if (!upload || upload.deckId !== request.resourceId || upload.userId !== claims.userId || upload.clientId !== claims.clientId || upload.expiresAt <= now(store)) fail(404, 'NOT_FOUND');
  return upload;
}

async function uploadDirectory(store) {
  await mkdir(store.blobs, { recursive: true, mode: 0o700 });
  const directory = join(store.blobs, '.uploads');
  await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077) fail(500, 'INVALID_UPLOAD_DIRECTORY');
}

async function openPart(store, upload) {
  const handle = await open(partPath(store, upload.id), constants.O_RDWR | constants.O_NOFOLLOW);
  const info = await handle.stat();
  let safeLinks = info.nlink === 1;
  if (info.nlink === 2) {
    const canonical = await lstat(join(store.blobs, upload.sha256)).catch(() => null);
    safeLinks = canonical?.isFile() && !canonical.isSymbolicLink() && canonical.ino === info.ino && canonical.dev === info.dev;
  }
  if (!info.isFile() || !safeLinks || info.mode & 0o077 || info.size > upload.byteLength) { await handle.close(); fail(500, 'INVALID_UPLOAD_FILE'); }
  return handle;
}

function validateMime(bytes, mimeType) {
  const ascii = (start, end) => bytes.subarray(start, end).toString('ascii');
  if (mimeType === 'image/png' && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (width > 0 && height > 0 && width * height <= 100000000) return;
  }
  if (mimeType === 'image/jpeg' && bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return;
  if (mimeType === 'image/webp' && bytes.length >= 12 && ascii(0,4) === 'RIFF' && ascii(8,12) === 'WEBP') return;
  if (mimeType === 'audio/wav' && bytes.length >= 12 && ascii(0,4) === 'RIFF' && ascii(8,12) === 'WAVE') return;
  if (mimeType === 'audio/mpeg' && bytes.length >= 3 && (ascii(0,3) === 'ID3' || bytes[0] === 255 && (bytes[1] & 224) === 224)) return;
  if (mimeType === 'audio/ogg' && bytes.length >= 4 && ascii(0,4) === 'OggS') return;
  if (mimeType === 'audio/mp4' && bytes.length >= 12 && ascii(4,8) === 'ftyp') return;
  fail(400, 'INVALID_ASSET_MIME');
}

export async function createUpload(state, request, claims, store) {
  const input = request.input;
  if (!mimeTypes.has(input.mimeType) || !Number.isSafeInteger(input.byteLength) || input.byteLength < 1 || input.byteLength > maximumBytes || !/^[a-f0-9]{64}$/.test(input.sha256 || '')) fail(400, 'INVALID_UPLOAD');
  await uploadDirectory(store);
  state.uploads ||= {};
  for (const [id, upload] of Object.entries(state.uploads)) if (upload.expiresAt <= now(store)) {
    if (/^[a-f0-9-]{36}$/.test(id)) await unlink(partPath(store, id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    delete state.uploads[id];
  }
  const pending = Object.values(state.uploads).filter(upload => !upload.stagedAssetId);
  if (pending.length >= 16 || pending.filter(upload => upload.userId === claims.userId).length >= 8) fail(429, 'UPLOAD_QUOTA');
  const id = randomUUID(), upload = { id, deckId: request.resourceId, userId: claims.userId, clientId: claims.clientId, mimeType: input.mimeType, byteLength: input.byteLength, sha256: input.sha256, rights: input.rights || 'unknown', sourceLabel: input.sourceLabel || '', receivedBytes: 0, expiresAt: now(store) + 3600000 };
  const handle = await open(partPath(store, id), 'wx', 0o600); await handle.close();
  state.uploads[id] = upload;
  return uploadView(upload);
}

export async function writeUploadChunk(state, request, claims, store) {
  const upload = ownedUpload(state, request, claims, store), { offset, data } = request.input;
  if (upload.stagedAssetId) fail(409, 'UPLOAD_COMPLETE');
  if (!Number.isSafeInteger(offset) || offset !== upload.receivedBytes || typeof data !== 'string' || data.length > Math.ceil(chunkBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) fail(400, 'INVALID_UPLOAD_CHUNK');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length < 1 || bytes.length > chunkBytes || bytes.toString('base64') !== data || offset + bytes.length > upload.byteLength) fail(400, 'INVALID_UPLOAD_CHUNK');
  const handle = await openPart(store, upload);
  try {
    const info = await handle.stat();
    if (info.size !== offset) {
      // Recover an already persisted chunk when the previous metadata commit failed.
      if (info.size !== offset + bytes.length) fail(409, 'UPLOAD_OFFSET_CONFLICT');
      const existing = Buffer.alloc(bytes.length); const read = await handle.read(existing, 0, existing.length, offset);
      if (read.bytesRead !== existing.length || !existing.equals(bytes)) fail(409, 'UPLOAD_OFFSET_CONFLICT');
    } else {
      let written = 0;
      while (written < bytes.length) { const result = await handle.write(bytes, written, bytes.length - written, offset + written); if (!result.bytesWritten) fail(500, 'UPLOAD_WRITE_FAILED'); written += result.bytesWritten; }
      await handle.sync();
    }
    upload.receivedBytes += bytes.length;
    return uploadView(upload);
  } finally { await handle.close(); }
}

export async function finishUpload(state, request, claims, store) {
  const upload = ownedUpload(state, request, claims, store);
  if (upload.stagedAssetId) return { resourceId: upload.deckId, stagedAssetId: upload.stagedAssetId, asset: state.assets[upload.stagedAssetId] && publicAsset(state.assets[upload.stagedAssetId]) };
  if (upload.receivedBytes !== upload.byteLength) fail(409, 'UPLOAD_INCOMPLETE');
  const handle = await openPart(store, upload);
  try {
    const digest = createHash('sha256'); let total = 0, header;
    for await (const bytes of handle.createReadStream({ autoClose: false, highWaterMark: chunkBytes, start: 0 })) { total += bytes.length; if (total > upload.byteLength) fail(400, 'UPLOAD_SIZE_MISMATCH'); if (!header) header = bytes.subarray(0,64); digest.update(bytes); }
    if (total !== upload.byteLength || digest.digest('hex') !== upload.sha256) fail(400, 'UPLOAD_HASH_MISMATCH');
    validateMime(header || Buffer.alloc(0), upload.mimeType);
    await link(partPath(store, upload.id), join(store.blobs, upload.sha256)).catch(async error => {
      if (error.code !== 'EEXIST') throw error;
      const info = await lstat(join(store.blobs, upload.sha256)); if (!info.isFile() || info.isSymbolicLink() || info.size !== upload.byteLength) fail(500, 'INVALID_ARTIFACT');
    });
    const id = randomUUID(), asset = { id, deckId: upload.deckId, blob: upload.sha256, mimeType: upload.mimeType, byteLength: upload.byteLength, sha256: upload.sha256, rights: upload.rights, sourceLabel: upload.sourceLabel, staged: true, expiresAt: now(store) + 3600000 };
    state.assets ||= {}; state.assets[id] = asset; upload.stagedAssetId = id;
    // The part remains until expiry, so an interrupted metadata commit can be retried.
    return { resourceId: upload.deckId, stagedAssetId: id, asset: publicAsset(asset) };
  } finally { await handle.close(); }
}

function publicAsset(asset) { const { blob, deckId, ...metadata } = asset; return metadata; }
