// The state of a ticket, to go on with it on another computer: its reports, logs,
// evidence and history (estado.json), plus the code changes as a patch, in a ZIP
// that travels as an attachment of the ticket. What comes from Jira (description,
// comments, attachments) is not included: each computer downloads it.
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeAtomic } from './jira.js';
import { ensureWorktree } from './jira-agents.js';
import { safeEntry, unzip, zip } from './zip.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const FORMAT = 1;
const MANIFEST = 'neo-team.json', PATCH = 'codigo.patch';
// Downloaded from Jira, the code itself (it goes as a patch) and files being written.
const FROM_JIRA = new Set(['adjuntos', 'codigo', 'descripcion.md', 'comentarios.md', 'comentarios.json']);
const skipped = name => FROM_JIRA.has(name.toLowerCase()) || name.startsWith('.') || /\.(tmp|part)$/i.test(name);
// What belongs to each computer and is kept when the state of another one arrives:
// what Jira says of the ticket and how this person sees it on the board.
const LOCAL = ['key', 'summary', 'type', 'jiraStatus', 'priority', 'updated', 'url', 'attachments', 'comments', 'skipped', 'assignee', 'news', 'archived', 'autoLock', 'inFilter', 'collectedAt', 'closedInJira', 'shared', 'sharedSeen', 'sharedOwn'];

function git(cwd, args, { env = {}, timeout = 5 * 60000 } = {}) {
  return new Promise((done, reject) => execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', ...args], { cwd, timeout, maxBuffer: 512 * 1024 * 1024, encoding: 'buffer', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } },
    (error, stdout, stderr) => error ? reject(new Error(String(stderr || error.message).trim().split('\n').slice(-3).join(' ').slice(0, 400) || 'git falló.')) : done(stdout)));
}
const hasCode = folder => stat(join(folder, 'codigo', '.git')).then(() => true, () => false);

// Every change of the ticket's worktree against its commit, new files included,
// read through a copy of its index so the worktree is left as it was.
export async function codeChanges(path) {
  const base = (await git(path, ['rev-parse', 'HEAD'])).toString('utf8').trim();
  const index = resolve(path, (await git(path, ['rev-parse', '--git-path', 'index'])).toString('utf8').trim());
  const temp = join(tmpdir(), `neo-team-index-${randomUUID()}`);
  try {
    await copyFile(index, temp).catch(() => {});
    const env = { GIT_INDEX_FILE: temp };
    await git(path, ['add', '-A'], { env });
    const patch = await git(path, ['diff', '--cached', '--binary', '--full-index', 'HEAD'], { env });
    return { base, patch };
  } finally { await rm(temp, { force: true }); }
}

async function folderEntries(folder, prefix = '') {
  const out = [];
  for (const entry of await readdir(join(folder, prefix), { withFileTypes: true }).catch(() => [])) {
    if (!prefix && skipped(entry.name)) continue;
    if (prefix && (entry.name.startsWith('.') || /\.(tmp|part)$/i.test(entry.name))) continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await folderEntries(folder, name));
    else if (entry.isFile()) out.push({ name: safeEntry(name), data: await readFile(join(folder, name)) });
  }
  return out;
}

// The ZIP with the state of the ticket, as it is on this computer.
export async function packState(tickets, key, { by = '' } = {}) {
  const folder = tickets.folder(key), ticket = await tickets.get(key);
  if (!ticket) throw fail('El ticket ya no está disponible.', 404);
  const entries = await folderEntries(folder);
  let base = null;
  if (await hasCode(folder)) {
    const code = await codeChanges(join(folder, 'codigo')).catch(error => { throw fail(`No se pudieron leer los cambios del código: ${error.message}`); });
    base = code.base;
    if (code.patch.length) entries.push({ name: PATCH, data: code.patch });
  }
  const manifest = { format: FORMAT, key, by, exportedAt: new Date().toISOString(), base, stage: ticket.stage, steps: (ticket.history ?? []).length };
  return { data: zip([{ name: MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2)) }, ...entries.filter(e => e.name !== MANIFEST)]), manifest, files: entries.length, patch: entries.some(e => e.name === PATCH) };
}

// Replaces the state of the ticket on this computer with the one in the ZIP. What
// there was is kept first in copias/, ZIP too, so nothing done here is lost.
export async function unpackState({ tickets, key, data, settings, me = null }) {
  const entries = unzip(data), manifest = JSON.parse(entries.find(e => e.name === MANIFEST)?.data.toString('utf8') ?? 'null');
  if (!manifest || manifest.key !== key) throw fail(`El adjunto no es un estado de ${key} guardado por Neo Team.`);
  if (manifest.format > FORMAT) throw fail('El estado lo guardó una versión más nueva de Neo Team: actualízala en este equipo.');
  const shared = JSON.parse(entries.find(e => e.name === 'estado.json')?.data.toString('utf8') ?? 'null');
  if (!shared) throw fail('El estado compartido no tiene el historial del ticket (estado.json).');
  const folder = tickets.folder(key), warnings = [];
  await mkdir(folder, { recursive: true, mode: 0o700 });

  // A copy of what there is now, with its code changes.
  const backupDir = join(tickets.root, 'copias'), backup = join(backupDir, `${key}-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
  // Without that copy nothing is replaced.
  const current = await packState(tickets, key).catch(error => { if (error.status === 404) return null; throw fail(`No se pudo guardar una copia del estado actual: ${error.message}`); });
  if (current) { await mkdir(backupDir, { recursive: true, mode: 0o700 }); await writeFile(backup, current.data, { mode: 0o600 }); }

  // The reports, logs and evidence of the other computer replace the ones here.
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    if (!skipped(entry.name) && entry.name !== 'estado.json') await rm(join(folder, entry.name), { recursive: true, force: true });
  }
  for (const entry of entries) {
    if ([MANIFEST, PATCH, 'estado.json'].includes(entry.name) || skipped(entry.name.split('/')[0])) continue;
    const file = join(folder, ...entry.name.split('/'));
    await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
    await writeFile(file, entry.data, { mode: 0o600 });
  }

  // The code: the worktree goes back to its commit and gets the changes of the patch.
  const patch = entries.find(e => e.name === PATCH)?.data ?? null, code = join(folder, 'codigo');
  if (await hasCode(folder)) {
    await git(code, ['reset', '--hard', '-q']).catch(() => {});
    await git(code, ['clean', '-fdq']).catch(() => {});
  }
  await rm(join(folder, PATCH), { force: true });
  if (patch) {
    const keep = async reason => { await writeFile(join(folder, PATCH), patch, { mode: 0o600 }); warnings.push(`${reason} Los cambios del código quedan en ${PATCH}, en la carpeta del ticket.`); };
    if (!settings.repository) await keep('No hay repositorio configurado en este equipo.');
    else {
      const file = join(tmpdir(), `neo-team-${randomUUID()}.patch`);
      try {
        await writeFile(file, patch);
        const { path } = await ensureWorktree(settings, { ...shared, key }, folder);
        const head = (await git(path, ['rev-parse', 'HEAD'])).toString('utf8').trim();
        const plain = await git(path, ['apply', '--check', '--binary', '--whitespace=nowarn', file]).then(() => true, () => false);
        if (plain) await git(path, ['apply', '--binary', '--whitespace=nowarn', file]);
        else {
          const merged = await git(path, ['apply', '--3way', '--binary', '--whitespace=nowarn', file]).then(() => true, () => false);
          if (merged) await git(path, ['reset', '-q']).catch(() => {});
          else {
            await git(path, ['reset', '--hard', '-q']).catch(() => {}); await git(path, ['clean', '-fdq']).catch(() => {});
            await keep(`Los cambios no encajan en la copia del código de este equipo${manifest.base && manifest.base !== head ? ` (parten de ${manifest.base.slice(0, 10)} y aquí de ${head.slice(0, 10)})` : ''}.`);
          }
        }
      } catch (error) { await keep(`No se pudo preparar la copia del código: ${error.message}`); }
      finally { await rm(file, { force: true }); }
    }
  }

  const updated = await tickets.update(key, t => {
    const mine = Object.fromEntries(LOCAL.filter(name => t?.[name] !== undefined).map(name => [name, t[name]]));
    const theirs = Object.fromEntries(Object.entries(shared).filter(([name]) => !LOCAL.includes(name) && name !== 'changedAt'));
    const assignee = mine.assignee ? { ...mine.assignee, me: !!me && mine.assignee.id === String(me.id) } : mine.assignee;
    return { ...theirs, ...mine, ...(assignee !== undefined ? { assignee } : {}), status: !theirs.status || theirs.status === 'running' ? 'pending' : theirs.status, resumedFrom: { by: manifest.by ?? '', at: manifest.exportedAt ?? null } };
  });
  return { ticket: updated, warnings, backup: current ? backup : null, manifest };
}
