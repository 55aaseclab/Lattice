import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const tags = new Map();
const MAX_TAGS = 128;

function matchesEntityTag(value, etag) {
  const normalize = tag => tag.trim().replace(/^W\//, "");
  return String(value).split(",").some(tag => tag.trim() === "*" || normalize(tag) === normalize(etag));
}

export async function imageCache(req, { file, stat, type, policy, vary }) {
  if (!["GET", "HEAD"].includes(req.method) || !/^image\//i.test(type)) return null;
  const fingerprint = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const previous = tags.get(file);
  let etag = previous?.fingerprint === fingerprint ? previous.etag : null;
  if (!etag) {
    etag = `"${createHash("sha256").update(await readFile(file)).digest("base64url")}"`;
    tags.delete(file);
    tags.set(file, { fingerprint, etag });
    if (tags.size > MAX_TAGS) tags.delete(tags.keys().next().value);
  }
  const variants = String(vary ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (!variants.some(value => value.toLowerCase() === "authorization")) variants.push("Authorization");
  const headers = {
    "Cache-Control": policy,
    "ETag": etag,
    "Last-Modified": stat.mtime.toUTCString(),
    "Vary": variants.includes("*") ? "*" : variants.join(", "),
  };
  const noneMatch = req.headers["if-none-match"];
  const modifiedSince = Date.parse(req.headers["if-modified-since"] ?? "");
  const notModified = noneMatch !== undefined
    ? matchesEntityTag(noneMatch, etag)
    : Number.isFinite(modifiedSince) && Math.floor(stat.mtimeMs / 1000) * 1000 <= modifiedSince;
  return { headers, notModified };
}
