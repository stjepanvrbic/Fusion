import { crc32, inflateRaw } from "node:zlib";
import { promisify } from "node:util";

/*
FNXC:PostMergeEvidence 2026-10-11-04:34:
Post-merge verification must read GitHub Actions artifact contents (notably post-merge-full-suite-evidence) on every host, including Windows hosts that have no `unzip` on PATH.
The archive is therefore parsed in memory with node:zlib instead of spawning a platform binary, and without a third-party zip dependency because the published CLI bundles the engine and the read is capped at 2 MB and 32 entries.
The reader never touches the filesystem. Every offset and length is bounds-checked against the archive, the entry count is checked before any record is walked, inflation is capped by maxOutputLength (decompression-bomb guard), and inflated output must match the declared size and CRC-32.
Multi-disk, zip64, encrypted, and non-stored/non-deflate entries are refused rather than partially read.
*/

const inflateRawAsync = promisify(inflateRaw);

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const END_RECORD_LENGTH = 22;
const CENTRAL_HEADER_LENGTH = 46;
const LOCAL_HEADER_LENGTH = 30;
const MAX_COMMENT_LENGTH = 0xffff;
const STORED = 0;
const DEFLATE = 8;
const ENCRYPTED_FLAG = 0x1;

export const ZIP_SIZE_LIMIT_MESSAGE = "Artifact exceeds the inspection size limit.";

const CORRUPT_ZIP_MESSAGE = "Artifact archive is corrupt or not a zip file.";
const UNSUPPORTED_ZIP_MESSAGE = "Artifact uses an unsupported zip feature.";
const ZIP_TOO_MANY_ENTRIES_MESSAGE = "Artifact contains too many entries.";

export interface ZipEntry {
  /** UTF-8 entry name, or null when the stored name bytes are not valid UTF-8. */
  name: string | null;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  method: number;
  localHeaderOffset: number;
  flags: number;
}

const corrupt = (): Error => new Error(CORRUPT_ZIP_MESSAGE);
const unsupported = (): Error => new Error(UNSUPPORTED_ZIP_MESSAGE);
const nameDecoder = new TextDecoder("utf-8", { fatal: true });

function decodeName(bytes: Buffer): string | null {
  try {
    return nameDecoder.decode(bytes);
  } catch {
    return null;
  }
}

function findEndRecord(archive: Buffer): number {
  const earliest = Math.max(0, archive.length - END_RECORD_LENGTH - MAX_COMMENT_LENGTH);
  for (let offset = archive.length - END_RECORD_LENGTH; offset >= earliest; offset -= 1) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY
      && offset + END_RECORD_LENGTH + archive.readUInt16LE(offset + 20) === archive.length) {
      return offset;
    }
  }
  throw corrupt();
}

/**
 * List the central-directory entries of an in-memory zip archive.
 * Names are decoded as strict UTF-8 regardless of the language-encoding flag: GitHub artifact entry names are ASCII, so an undecodable name is reported as `null` for the caller to reject.
 */
export function listZipEntries(archive: Buffer, limits: { maxEntries: number }): ZipEntry[] {
  if (archive.length < END_RECORD_LENGTH) throw corrupt();
  const end = findEndRecord(archive);
  const diskNumber = archive.readUInt16LE(end + 4);
  const directoryDisk = archive.readUInt16LE(end + 6);
  const diskEntries = archive.readUInt16LE(end + 8);
  const totalEntries = archive.readUInt16LE(end + 10);
  const directorySize = archive.readUInt32LE(end + 12);
  const directoryOffset = archive.readUInt32LE(end + 16);
  if (diskNumber !== 0 || directoryDisk !== 0 || diskEntries !== totalEntries
    || totalEntries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw unsupported();
  }
  if (totalEntries > limits.maxEntries) throw new Error(ZIP_TOO_MANY_ENTRIES_MESSAGE);
  const directoryEnd = directoryOffset + directorySize;
  if (directoryEnd > end) throw corrupt();

  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + CENTRAL_HEADER_LENGTH > directoryEnd || archive.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_HEADER) throw corrupt();
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const checksum = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const startDisk = archive.readUInt16LE(cursor + 34);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);
    const recordEnd = cursor + CENTRAL_HEADER_LENGTH + nameLength + extraLength + commentLength;
    if (recordEnd > directoryEnd) throw corrupt();
    if (startDisk !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
      || localHeaderOffset === 0xffffffff || (flags & ENCRYPTED_FLAG) !== 0
      || (method !== STORED && method !== DEFLATE)) {
      throw unsupported();
    }
    const name = decodeName(archive.subarray(cursor + CENTRAL_HEADER_LENGTH, cursor + CENTRAL_HEADER_LENGTH + nameLength));
    entries.push({ name, compressedSize, uncompressedSize, crc32: checksum, method, localHeaderOffset, flags });
    cursor = recordEnd;
  }
  return entries;
}

/** Inflate one entry in memory, refusing output beyond `maxBytes` and output that fails the declared size or CRC-32. */
export async function readZipEntry(archive: Buffer, entry: ZipEntry, maxBytes: number): Promise<Buffer> {
  if (entry.uncompressedSize > maxBytes) throw new Error(ZIP_SIZE_LIMIT_MESSAGE);
  const header = entry.localHeaderOffset;
  if (header + LOCAL_HEADER_LENGTH > archive.length || archive.readUInt32LE(header) !== LOCAL_FILE_HEADER) throw corrupt();
  const dataStart = header + LOCAL_HEADER_LENGTH + archive.readUInt16LE(header + 26) + archive.readUInt16LE(header + 28);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > archive.length) throw corrupt();
  const data = archive.subarray(dataStart, dataEnd);
  let output: Buffer;
  if (entry.method === STORED) {
    output = data;
  } else {
    try {
      output = await inflateRawAsync(data, { maxOutputLength: Math.max(1, maxBytes) });
    } catch (error) {
      if ((error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE" || error instanceof RangeError) {
        throw new Error(ZIP_SIZE_LIMIT_MESSAGE);
      }
      throw corrupt();
    }
  }
  if (output.length !== entry.uncompressedSize || (crc32(output) >>> 0) !== entry.crc32) throw corrupt();
  return output;
}
