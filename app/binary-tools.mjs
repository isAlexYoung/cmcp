import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const chunkSize = 1048576;
const property = { type: 'string', description: 'Absolute Windows file path.' };
const define = (name, description, properties, required, readOnly = false) => ({
  name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly },
});
export const binaryDefinitions = [
  define('windows_binary_info', 'Get size and SHA-256 of any Windows file, including video, audio, PDF, Office and ZIP.', { path: property }, ['path'], true),
  define('windows_binary_read', 'Read up to 1 MiB of raw bytes as base64. Prefer windows_download_to_cloud for file transfer without placing bytes in chat.', { path: property, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1, maximum: chunkSize } }, ['path', 'offset'], true),
  define('windows_binary_begin', 'Begin an atomic binary upload to Windows. Existing files require overwrite=true. Returns upload_id.', { path: property, size: { type: 'integer', minimum: 0 }, sha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' }, overwrite: { type: 'boolean', default: false } }, ['path', 'size', 'sha256']),
  define('windows_binary_write', 'Append one base64 chunk at the exact next offset of an upload.', { upload_id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, data: { type: 'string', maxLength: 1398104 } }, ['upload_id', 'offset', 'data']),
  define('windows_binary_finish', 'Validate size and SHA-256 then atomically publish an uploaded file, or cancel and remove its temporary file.', { upload_id: { type: 'string' }, cancel: { type: 'boolean', default: false } }, ['upload_id']),
];

export function createBinaryTools({ roots }) {
  const uploads = new Map();
  function allowed(file, writing = false) {
    if (typeof file !== 'string' || !path.win32.isAbsolute(file) || file.includes('\0') || /(^|[\\/])[^\\/]*:/.test(file.slice(3))) throw new Error('Use an absolute Windows file path without alternate data streams');
    const resolved = path.resolve(file);
    const real = writing ? path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved)) : fs.realpathSync(resolved);
    const inside = root => {
      let base;
      try { base = fs.realpathSync(root); } catch { return false; } // e.g. a removed USB drive
      const relative = path.relative(base, real);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    };
    if (!roots.some(inside)) throw new Error('File is outside allowed Windows roots');
    return real;
  }
  // Publish without overwriting. Hard links are atomic, but FAT32/exFAT USB drives and many network
  // shares do not support them; fall back to an exclusive copy there.
  function publishNew(temporary, file) {
    try {
      fs.linkSync(temporary, file);
    } catch (error) {
      if (error.code === 'EEXIST') throw error;
      fs.copyFileSync(temporary, file, fs.constants.COPYFILE_EXCL);
    }
    fs.unlinkSync(temporary);
  }
  async function hash(file) {
    const digest = createHash('sha256');
    for await (const bytes of fs.createReadStream(file)) digest.update(bytes);
    return digest.digest('hex');
  }
  async function call(name, args) {
    let result;
    if (name === 'windows_binary_info') {
      const file = allowed(args.path);
      const stat = fs.statSync(file);
      if (!stat.isFile()) throw new Error('Expected a regular file');
      result = { path: file, size: stat.size, sha256: await hash(file) };
    } else if (name === 'windows_binary_read') {
      const file = allowed(args.path);
      const length = args.length ?? chunkSize;
      if (!Number.isSafeInteger(args.offset) || args.offset < 0 || !Number.isInteger(length) || length < 1 || length > chunkSize) throw new Error('Invalid chunk offset or length');
      const fd = fs.openSync(file, 'r');
      try {
        if (!fs.fstatSync(fd).isFile()) throw new Error('Expected a regular file');
        const buffer = Buffer.alloc(length);
        const count = fs.readSync(fd, buffer, 0, length, args.offset);
        result = { offset: args.offset, bytes: count, data: buffer.subarray(0, count).toString('base64') };
      } finally { fs.closeSync(fd); }
    } else if (name === 'windows_binary_begin') {
      if (uploads.size >= 8) throw new Error('Too many active binary uploads');
      if (!Number.isSafeInteger(args.size) || args.size < 0 || !/^[a-fA-F0-9]{64}$/.test(args.sha256)) throw new Error('Invalid size or SHA-256');
      const file = allowed(args.path, true);
      if (!args.overwrite && fs.existsSync(file)) throw new Error('Destination exists; explicitly set overwrite=true');
      const id = randomUUID();
      const temporary = path.join(path.dirname(file), '.mcp-upload-' + id);
      const fd = fs.openSync(temporary, 'wx');
      uploads.set(id, { file, temporary, fd, size: args.size, sha256: args.sha256.toLowerCase(), offset: 0, overwrite: args.overwrite === true });
      result = { upload_id: id, chunk_size: chunkSize };
    } else {
      const upload = uploads.get(args.upload_id);
      if (!upload) throw new Error('Unknown upload ID; the service may have restarted');
      if (name === 'windows_binary_write') {
        if (args.offset !== upload.offset || typeof args.data !== 'string' || args.data.length > 1398104 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.data)) throw new Error('Invalid base64 or out-of-order chunk');
        const buffer = Buffer.from(args.data, 'base64');
        if (buffer.length > chunkSize || upload.offset + buffer.length > upload.size) throw new Error('Chunk exceeds expected file size');
        let written = 0;
        while (written < buffer.length) written += fs.writeSync(upload.fd, buffer, written, buffer.length - written, upload.offset + written);
        upload.offset += written;
        result = { upload_id: args.upload_id, next_offset: upload.offset };
      } else {
        try {
          fs.closeSync(upload.fd);
          if (args.cancel) result = { cancelled: true };
          else {
            if (upload.offset !== upload.size || await hash(upload.temporary) !== upload.sha256) throw new Error('Size or SHA-256 mismatch; upload discarded');
            if (allowed(upload.file, true) !== upload.file) throw new Error('Destination changed during upload');
            if (upload.overwrite) fs.renameSync(upload.temporary, upload.file);
            else publishNew(upload.temporary, upload.file);
            result = { path: upload.file, size: upload.size, sha256: upload.sha256 };
          }
        } finally {
          uploads.delete(args.upload_id);
          if (fs.existsSync(upload.temporary)) fs.unlinkSync(upload.temporary);
        }
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  }
  return { definitions: binaryDefinitions, owns: name => binaryDefinitions.some(tool => tool.name === name), call,
    close() { for (const upload of uploads.values()) { try { fs.closeSync(upload.fd); } catch {} try { fs.unlinkSync(upload.temporary); } catch {} } uploads.clear(); },
  };
}
