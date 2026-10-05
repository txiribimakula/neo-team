// Reading the files of a pull request from Azure DevOps. A failed read does not
// always come as an error: Azure may answer with its error message as the file
// content, so that answer is recognised instead of being reviewed as code.
import { gunzipSync } from 'node:zlib';

const CHANGE_TYPES = [[16, 'delete'], [1, 'add'], [8, 'rename'], [2, 'edit']];
// The change type comes as flags, or as their names when it is not converted.
export const changeType = value => typeof value === 'string'
  ? CHANGE_TYPES.map(([, name]) => name).find(name => value.toLowerCase().includes(name)) ?? 'edit'
  : CHANGE_TYPES.find(([bit]) => (Number(value) & bit) !== 0)?.[1] ?? 'edit';

// The error Azure DevOps writes in place of a file: {"$id", "message", "typeName", "typeKey", …}.
export function azureStreamError(text) {
  if (!/^\s*\{/.test(text) || text.length > 20000) return null;
  try {
    const json = JSON.parse(text);
    return typeof json?.message === 'string' && typeof json.typeName === 'string' && typeof json.typeKey === 'string' ? json.message : null;
  } catch { return null; }
}

export async function readText(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) { stream.destroy?.(); return { tooLarge: true, size }; }
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  let buffer = Buffer.concat(chunks);
  if (/gzip/i.test(stream.headers?.['content-encoding'] ?? '')) buffer = gunzipSync(buffer);
  const status = stream.statusCode;
  if (status && (status < 200 || status >= 300)) return { error: `HTTP ${status}${azureStreamError(buffer.toString('utf8')) ? `: ${azureStreamError(buffer.toString('utf8'))}` : ''}` };
  const content = decodeContent(buffer, size), error = content.text !== undefined && azureStreamError(content.text);
  return error ? { error } : content;
}
// The text of a file, wherever it was read: UTF-16 files (common in .NET and SQL
// projects) carry a byte order mark, and a NUL byte at the start marks a binary file.
export function decodeContent(buffer, size = buffer.length) {
  const utf16 = buffer[0] === 0xff && buffer[1] === 0xfe ? 'le' : buffer[0] === 0xfe && buffer[1] === 0xff ? 'be' : null;
  if (utf16) {
    const bytes = utf16 === 'be' ? Buffer.from(buffer.subarray(2)).swap16() : buffer.subarray(2);
    return { text: bytes.subarray(0, bytes.length - bytes.length % 2).toString('utf16le'), size };
  }
  if (buffer.subarray(0, 8000).includes(0)) return { binary: true, size };
  return { text: buffer.toString('utf8').replace(/^\uFEFF/, ''), size };
}

// One side of a changed file: by its blob and, if Azure does not serve it, by its
// path at the commit of that side. A file that still cannot be read says why.
const attempt = async read => { try { return await read(); } catch (error) { return { error: error.message }; } };
export async function readSide({ blob, item, sha, path, commit, limit }) {
  if (!sha && !commit) return { text: '' };
  const first = sha ? await attempt(async () => readText(await blob(sha), limit)) : null;
  if (first && !first.error) return first;
  if (path && commit) {
    const second = await attempt(async () => readText(await item(path, commit), limit));
    if (!second.error) return second;
    return first ?? second;
  }
  return first;
}
