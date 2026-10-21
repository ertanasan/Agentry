// Files attached to a request from the web UI's new-request and answer forms. The agent reads them: each run copies
// them into its temp dir, which the sandbox lets it read, and the prompt names them. Accepted: images (PNG, JPEG, GIF,
// WebP) and PDF, which claude's Read tool shows; text (UTF-8, no NUL bytes); and Office files (.docx, .xlsx,
// .pptx), which the agent unpacks itself. A type is recognized by the file's bytes, never by its name or the
// browser's content type. Archives and executables are refused. Files are immutable, at
// $AGENTRY_HOME/attachments/<request>/<id>.<ext>.
import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ActionError } from "./actions.ts";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_REQUEST = 5;

export type Upload = { name: string; bytes: Uint8Array };
export type Attachment = { id: number; request_id: number; name: string; mime: string; size: number };

export const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "application/pdf": "pdf",
  [DOCX]: "docx", [XLSX]: "xlsx", [PPTX]: "pptx",
};
// A text file keeps its own extension when it is one of these, so the agent knows what it reads; others get .txt.
const TEXT_EXTS = new Set(["txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "log", "yaml", "yml", "xml", "html", "htm", "sql", "toml", "ini", "diff", "patch"]);

// The file's type from its bytes, or null.
export function sniff(b: Uint8Array): string | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (at(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf"; // %PDF-
  if (at(0, 0x50, 0x4b, 0x03, 0x04)) return office(b);                // a ZIP: only an Office file passes
  return isText(b) ? "text/plain" : null;
}

// An Office file is a ZIP of XML whose entry names (stored uncompressed in the ZIP) say what it is.
function office(b: Uint8Array): string | null {
  const bytes = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (!bytes.includes("[Content_Types].xml")) return null;
  if (bytes.includes("word/document.xml")) return DOCX;
  if (bytes.includes("xl/workbook.xml")) return XLSX;
  if (bytes.includes("ppt/presentation.xml")) return PPTX;
  return null;
}

function isText(b: Uint8Array): boolean {
  if (b.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(b); return true; } catch { return false; }
}

const isHeic = (b: Uint8Array) => /^ftyp(heic|heix|hevc|hevx|mif1|msf1)/.test(new TextDecoder().decode(b.subarray(4, 12)));
const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
// Word, Excel and PowerPoint before 2007: an OLE compound file.
const isOldOffice = (b: Uint8Array) => [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((x, i) => b[i] === x);

// The types of `uploads`, or an ActionError ("invalid") naming the first file that is not a supported type, is too
// big, or would take the request over the limit.
export function checkUploads(db: Database, requestId: number | null, uploads: Upload[]): string[] {
  const already = requestId === null ? 0
    : (db.query("SELECT COUNT(*) AS n FROM attachments WHERE request_id = ?").get(requestId) as { n: number }).n;
  if (already + uploads.length > MAX_FILES_PER_REQUEST) throw new ActionError(`at most ${MAX_FILES_PER_REQUEST} files per request`, "invalid");
  return uploads.map((u) => {
    if (u.bytes.length > MAX_FILE_BYTES) throw new ActionError(`${u.name} is over ${MAX_FILE_BYTES / 1024 / 1024} MB`, "invalid");
    const mime = sniff(u.bytes);
    if (mime) return mime;
    throw new ActionError(
      isHeic(u.bytes) ? `${u.name} is a HEIC photo, which the agent cannot read: attach a screenshot, or a photo exported as JPEG`
      : isOldOffice(u.bytes) ? `${u.name} is an old Office file: save it as .docx, .xlsx or .pptx, or as PDF`
      : isZip(u.bytes) ? `${u.name} is an archive, which isn't accepted: attach the files in it`
      : `${u.name} is not a supported file: attach images (PNG, JPEG, GIF, WebP), PDF, text or Office files (.docx, .xlsx, .pptx)`,
      "invalid");
  });
}

// The extension a stored attachment has on disk.
export function extOf(a: { mime: string; name: string }): string {
  if (a.mime !== "text/plain") return EXT[a.mime];
  const ext = a.name.match(/\.([A-Za-z0-9]+)$/)?.[1].toLowerCase();
  return ext && TEXT_EXTS.has(ext) ? ext : "txt";
}

// Records and writes uploads that checkUploads accepted (`types` is its result). Call it in the transaction that adds
// or answers the request, so a refused request leaves no rows behind.
export function saveUploads(db: Database, home: string, requestId: number, uploads: Upload[], types: string[]): void {
  if (!uploads.length) return;
  const dir = join(home, "attachments", String(requestId));
  mkdirSync(dir, { recursive: true });
  uploads.forEach((u, i) => {
    const name = u.name.replace(/[\x00-\x1f\x7f]/g, "").slice(-100) || "file";
    const id = Number(db.query("INSERT INTO attachments (request_id, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(requestId, name, types[i], u.bytes.length, Date.now()).lastInsertRowid);
    writeFileSync(join(dir, `${id}.${extOf({ mime: types[i], name })}`), u.bytes);
  });
}

export function attachment(db: Database, id: number): Attachment | null {
  return db.query("SELECT id, request_id, name, mime, size FROM attachments WHERE id = ?").get(id) as Attachment | null;
}

export function attachmentFile(home: string, a: Attachment): string {
  return join(home, "attachments", String(a.request_id), `${a.id}.${extOf(a)}`);
}

export type RunFile = { path: string; name: string; mime: string };

// Copies a request's files into `dir` for a run and returns them, oldest first.
export function copyForRun(db: Database, home: string, requestId: number, dir: string): RunFile[] {
  const all = db.query("SELECT id, request_id, name, mime, size FROM attachments WHERE request_id = ? ORDER BY id").all(requestId) as Attachment[];
  const files: RunFile[] = [];
  for (const a of all) {
    const from = attachmentFile(home, a);
    if (!existsSync(from)) continue;
    mkdirSync(dir, { recursive: true });
    const to = join(dir, `${a.id}.${extOf(a)}`);
    copyFileSync(from, to);
    files.push({ path: to, name: a.name, mime: a.mime });
  }
  return files;
}
