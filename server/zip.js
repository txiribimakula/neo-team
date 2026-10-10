// A small ZIP reader and writer, enough for the state of a ticket: deflated
// entries with UTF-8 names, which Windows Explorer opens as well.
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const fail = message => Object.assign(new Error(message), { status: 400 });
const UTF8 = 0x0800;

function dosTime(date) {
  const d = new Date(date);
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2), date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

// entries: [{ name: 'a/b.md', data: Buffer }]
export function zip(entries, at = new Date()) {
  const { time, date } = dosTime(at), parts = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8'), data = Buffer.from(entry.data), packed = deflateRawSync(data), crc = crc32(data);
    const stored = packed.length >= data.length, body = stored ? data : packed, method = stored ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(UTF8, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(UTF8, 8); head.writeUInt16LE(method, 10);
    head.writeUInt16LE(time, 12); head.writeUInt16LE(date, 14); head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(body.length, 20); head.writeUInt32LE(data.length, 24); head.writeUInt16LE(name.length, 28); head.writeUInt32LE(offset, 42);
    parts.push(local, name, body); central.push(head, name);
    offset += local.length + name.length + body.length;
    if (offset > 0xffffffff) throw fail('El estado del ticket ocupa demasiado para un ZIP.');
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

// Returns [{ name, data }]; names are checked so nothing lands outside the folder.
export function unzip(buffer, { maxBytes = 1024 * 1024 * 1024 } = {}) {
  const start = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (start < 0 || start + 22 > buffer.length) throw fail('El adjunto no es un ZIP válido.');
  const count = buffer.readUInt16LE(start + 10);
  let at = buffer.readUInt32LE(start + 16), total = 0;
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw fail('El adjunto no es un ZIP válido.');
    const method = buffer.readUInt16LE(at + 10), crc = buffer.readUInt32LE(at + 16), packed = buffer.readUInt32LE(at + 20), size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28), extra = buffer.readUInt16LE(at + 30), comment = buffer.readUInt16LE(at + 32), offset = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extra + comment;
    if (name.endsWith('/')) continue;
    if (![0, 8].includes(method)) throw fail(`El ZIP usa una compresión no admitida en ${name}.`);
    total += size;
    if (total > maxBytes) throw fail('El estado del ticket ocupa demasiado.');
    const bodyAt = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    const body = buffer.subarray(bodyAt, bodyAt + packed), data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    if (data.length !== size || crc32(data) !== crc) throw fail(`El ZIP está dañado (${name}).`);
    entries.push({ name: safeEntry(name), data });
  }
  return entries;
}

// Relative paths with forward slashes, no drive letters, «..» or names Windows rejects.
export function safeEntry(name) {
  const parts = String(name).replace(/\\/g, '/').split('/');
  if (!parts.length || parts.some(p => !p || p === '.' || p === '..' || /[<>:"|?*\u0000-\u001f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p))) throw fail(`El ZIP contiene una ruta no válida: ${name}`);
  return parts.join('/');
}
