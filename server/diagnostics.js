import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Failures of the application itself, as opposed to answers from Azure DevOps
// or validation messages, which already explain what happened.
const INTERNAL = ['TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'DataCloneError'];
export const isInternalError = error => INTERNAL.includes(error?.name) && !error?.status;

// First stack frame inside this project, as "file.js:line".
export function errorLocation(error) {
  for (const line of String(error?.stack ?? '').split('\n').slice(1)) {
    const match = line.match(/(?:server|dist)\/([\w.-]+\.js):(\d+)/);
    if (match) return `${match[1]}:${match[2]}`;
  }
  return null;
}

export function describeError(error) {
  return {
    name: error?.name ?? typeof error, message: String(error?.message ?? error),
    code: error?.code, statusCode: error?.statusCode, location: errorLocation(error),
    stack: String(error?.stack ?? '').split('\n').slice(0, 15).join('\n'),
  };
}

// The last failure stays next to the local copy, so it can be read on the
// machine running the server. Activity messages never carry credentials.
export async function recordFailure(directory, report) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'last-error.json'), temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify({ recordedAt: new Date().toISOString(), node: process.version, platform: process.platform, ...report }, null, 2), { mode: 0o600 });
  await rename(temp, file);
  return file;
}
