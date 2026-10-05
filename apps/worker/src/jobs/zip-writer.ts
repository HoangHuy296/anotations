import { crc32 } from "node:zlib";

/**
 * specs/028-multi-format-export §8 -- a minimal, dependency-free, STORE-only
 * (uncompressed) ZIP archive writer, used for every multi-file export
 * format (YOLO today; VOC/LabelMe/OpenImages later). No new npm package:
 * AGENTS.md requires explicit permission before adding one, and a
 * store-mode ZIP is a small, fully-specified binary format Node's built-in
 * `zlib.crc32` already makes straightforward to implement correctly.
 *
 * Deterministic by construction, required for "deterministic output"
 * (specs/028 §10's YOLO freeze list): every entry uses a fixed constant
 * DOS timestamp (1980-01-01, the format's own minimum), never `Date.now()`
 * -- re-running the same export twice produces a byte-identical archive.
 * Entries are written in exactly the order given by the caller; callers are
 * responsible for passing them in their own already-deterministic order
 * (this module never re-sorts).
 *
 * Verified against a real unzip implementation (Python's `zipfile`) during
 * development -- not merely "should be spec-compliant".
 */

export type ZipEntry = { path: string; content: Buffer };

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
/** DOS date/time for 1980-01-01 00:00:00 -- the format's own minimum
 * representable timestamp, used as a fixed constant for determinism. */
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 0x21; // 1980-01-01
const UTF8_FILENAME_FLAG = 0x0800;

export function buildZipArchive(entries: readonly ZipEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.path, "utf8");
    const checksum = crc32(entry.content) >>> 0;
    const size = entry.content.byteLength;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
    localHeader.writeUInt16LE(20, 4); // version needed to extract
    localHeader.writeUInt16LE(UTF8_FILENAME_FLAG, 6); // general purpose flag
    localHeader.writeUInt16LE(0, 8); // compression method: 0 = store
    localHeader.writeUInt16LE(FIXED_DOS_TIME, 10);
    localHeader.writeUInt16LE(FIXED_DOS_DATE, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(size, 18); // compressed size == uncompressed size (store)
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBuffer.byteLength, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localChunks.push(localHeader, nameBuffer, entry.content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(UTF8_FILENAME_FLAG, 8);
    centralHeader.writeUInt16LE(0, 10); // compression method
    centralHeader.writeUInt16LE(FIXED_DOS_TIME, 12);
    centralHeader.writeUInt16LE(FIXED_DOS_DATE, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBuffer.byteLength, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(0, 38); // external file attributes
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header

    centralChunks.push(centralHeader, nameBuffer);

    offset += localHeader.byteLength + nameBuffer.byteLength + entry.content.byteLength;
  }

  const centralDirectoryOffset = offset;
  const centralDirectory = Buffer.concat(centralChunks);
  const centralDirectorySize = centralDirectory.byteLength;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDirectorySize, 12);
  eocd.writeUInt32LE(centralDirectoryOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localChunks, centralDirectory, eocd]);
}
