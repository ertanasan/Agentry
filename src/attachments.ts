// Images attached to a request from the web UI's new-request and answer forms. The agent sees them: each run copies
// them into its temp dir, which the sandbox lets it read, and the prompt names them for claude's Read tool.
// Only PNG, JPEG, GIF and WebP (what claude reads), recognized by their first bytes, never by the file name or the
// browser's content type. Files are immutable, at $AGENTRY_HOME/attachments/<request>/<id>.<ext>.
import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ActionError } from "./actions.ts";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES_PER_REQUEST = 5;

export type Upload = { name: string; bytes: Uint8Array };
export type Attachment = { id: number; request_id: number; name: string; mime: string; size: number };

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

// The image type from the file's first bytes, or null.
export function sniff(b: Uint8Array): string | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

const isHeic = (b: Uint8Array) => /^ftyp(heic|heix|hevc|hevx|mif1|msf1)/.test(new TextDecoder().decode(b.subarray(4, 12)));

// The image types of `uploads`, or an ActionError ("invalid") naming the first file that is not a supported image,
// is too big, or would take the request over the limit.
export function checkUploads(db: Database, requestId: number | null, uploads: Upload[]): string[] {
  const already = requestId === null ? 0
    : (db.query("SELECT COUNT(*) AS n FROM attachments WHERE request_id = ?").get(requestId) as { n: number }).n;
  if (already + uploads.length > MAX_IMAGES_PER_REQUEST) throw new ActionError(`at most ${MAX_IMAGES_PER_REQUEST} images per request`, "invalid");
  return uploads.map((u) => {
    if (u.bytes.length > MAX_IMAGE_BYTES) throw new ActionError(`${u.name} is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB`, "invalid");
    const mime = sniff(u.bytes);
    if (mime) return mime;
    throw new ActionError(isHeic(u.bytes)
      ? `${u.name} is a HEIC photo, which the agent cannot read: attach a screenshot, or a photo exported as JPEG`
      : `${u.name} is not a PNG, JPEG, GIF or WebP image`, "invalid");
  });
}

// Records and writes uploads that checkUploads accepted (`types` is its result). Call it in the transaction that adds
// or answers the request, so a refused request leaves no rows behind.
export function saveUploads(db: Database, home: string, requestId: number, uploads: Upload[], types: string[]): void {
  if (!uploads.length) return;
  const dir = join(home, "attachments", String(requestId));
  mkdirSync(dir, { recursive: true });
  uploads.forEach((u, i) => {
    const name = u.name.replace(/[\x00-\x1f\x7f]/g, "").slice(-100) || "image";
    const id = Number(db.query("INSERT INTO attachments (request_id, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(requestId, name, types[i], u.bytes.length, Date.now()).lastInsertRowid);
    writeFileSync(join(dir, `${id}.${EXT[types[i]]}`), u.bytes);
  });
}

export function attachment(db: Database, id: number): Attachment | null {
  return db.query("SELECT id, request_id, name, mime, size FROM attachments WHERE id = ?").get(id) as Attachment | null;
}

export function attachmentFile(home: string, a: Attachment): string {
  return join(home, "attachments", String(a.request_id), `${a.id}.${EXT[a.mime]}`);
}

// Copies a request's images into `dir` for a run and returns their paths, oldest first.
export function copyForRun(db: Database, home: string, requestId: number, dir: string): string[] {
  const all = db.query("SELECT id, request_id, name, mime, size FROM attachments WHERE request_id = ? ORDER BY id").all(requestId) as Attachment[];
  const paths: string[] = [];
  for (const a of all) {
    const from = attachmentFile(home, a);
    if (!existsSync(from)) continue;
    mkdirSync(dir, { recursive: true });
    const to = join(dir, `${a.id}.${EXT[a.mime]}`);
    copyFileSync(from, to);
    paths.push(to);
  }
  return paths;
}
