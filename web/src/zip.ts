// Reading a zip from a File by random access: the central directory gives
// every entry's place in the file, so entries are read one by one with
// File.slice() and nothing larger than one entry is ever in memory. Stored
// entries (the images of a pack) are copied as they are; deflated ones go
// through the browser's DecompressionStream.

export interface ZipEntry {
  path: string;          // as in the zip, "/"-separated
  method: number;        // 0 stored, 8 deflated
  compressedSize: number;
  size: number;
  headerOffset: number;  // of the entry's local header
  isDir: boolean;
  isSymlink: boolean;
  encrypted: boolean;
}

export class ZipError extends Error {}

const EOCD = 0x06054b50, EOCD64 = 0x06064b50, LOCATOR64 = 0x07064b50;
const CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
const MAX32 = 0xffffffff;

async function bytes(file: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await file.slice(start, end).arrayBuffer());
}

function big(v: DataView, at: number): number {
  const n = v.getBigUint64(at, true);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError("zip too large");
  return Number(n);
}

/** All entries of the zip, from its central directory (zip64 included). */
export async function readEntries(file: Blob): Promise<ZipEntry[]> {
  // end of central directory: in the last 22 bytes + up to 64 KiB of comment
  const tailStart = Math.max(0, file.size - 22 - 0xffff);
  const tail = await bytes(file, tailStart, file.size);
  let at = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD) { at = i; break; }
  }
  if (at < 0) throw new ZipError("not a zip file");
  let count = tail.getUint16(at + 10, true);
  let cdSize = tail.getUint32(at + 12, true);
  let cdOffset = tail.getUint32(at + 16, true);
  if (count === 0xffff || cdSize === MAX32 || cdOffset === MAX32) {
    const loc = at - 20;                     // zip64 locator, right before
    if (loc < 0 || tail.getUint32(loc, true) !== LOCATOR64) throw new ZipError("broken zip64 file");
    const eocd64At = big(tail, loc + 8);
    const e = await bytes(file, eocd64At, eocd64At + 56);
    if (e.getUint32(0, true) !== EOCD64) throw new ZipError("broken zip64 file");
    count = big(e, 32);
    cdSize = big(e, 40);
    cdOffset = big(e, 48);
  }

  const cd = await bytes(file, cdOffset, cdOffset + cdSize);
  const dec = new TextDecoder();
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (cd.getUint32(p, true) !== CENTRAL) throw new ZipError("broken central directory");
    const flags = cd.getUint16(p + 8, true);
    const method = cd.getUint16(p + 10, true);
    let compressedSize = cd.getUint32(p + 20, true);
    let size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const external = cd.getUint32(p + 38, true);
    let headerOffset = cd.getUint32(p + 42, true);
    const path = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    // zip64 extra field: the 64-bit values, in this order, for those set to MAX32
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = cd.getUint16(x, true), len = cd.getUint16(x + 2, true);
      if (id === 0x0001) {
        let q = x + 4;
        if (size === MAX32) { size = big(cd, q); q += 8; }
        if (compressedSize === MAX32) { compressedSize = big(cd, q); q += 8; }
        if (headerOffset === MAX32) { headerOffset = big(cd, q); q += 8; }
      }
      x += 4 + len;
    }
    entries.push({
      path, method, compressedSize, size, headerOffset,
      isDir: path.endsWith("/"),
      isSymlink: ((external >>> 16) & 0o170000) === 0o120000,
      encrypted: (flags & 1) === 1,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** The entry's contents as a stream (decompressed). */
export async function entryStream(file: Blob, e: ZipEntry): Promise<ReadableStream<Uint8Array>> {
  if (e.encrypted) throw new ZipError(`${e.path}: encrypted entries are not supported`);
  const h = await bytes(file, e.headerOffset, e.headerOffset + 30);
  if (h.getUint32(0, true) !== LOCAL) throw new ZipError(`${e.path}: broken entry`);
  const start = e.headerOffset + 30 + h.getUint16(26, true) + h.getUint16(28, true);
  const data = file.slice(start, start + e.compressedSize);
  if (e.method === 0) return data.stream();
  if (e.method === 8) return data.stream().pipeThrough(new DecompressionStream("deflate-raw"));
  throw new ZipError(`${e.path}: compression method ${e.method} is not supported`);
}

/** A path from a zip, made safe to write: "/"-separated parts with no empty,
 * "." or ".." part, no backslash or drive letter. null if it is not safe. */
export function safePath(path: string): string | null {
  if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) return null;
  const parts = path.split("/").filter((s) => s !== "");
  if (!parts.length || parts.some((s) => s === "." || s === ".." || s.includes("\0"))) return null;
  return parts.join("/");
}
