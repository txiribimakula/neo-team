// Pull request diff from a local clone of the repository. The pull request's
// branches are fetched and the files are read with git, between the common base
// and the commit Azure DevOps reports for the pull request, so the review matches
// what is later checked before publishing.
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { decodeContent } from './pr-content.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const CHANGE_TYPES = { A: 'add', C: 'add', D: 'delete', M: 'edit', R: 'rename', T: 'edit' };

// git never asks for credentials in a terminal nobody sees, and the repository's
// file monitor is not started for these reads.
export function git(cwd, args, { timeout = 120000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', ...args], { cwd, timeout, maxBuffer, encoding: 'buffer', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(String(stderr || error.message).trim().split('\n').slice(-3).join(' ').slice(0, 400) || 'git falló.'), { code: error.code }));
      else resolve(stdout);
    });
  });
}
const text = async (cwd, args, options) => (await git(cwd, args, options)).toString('utf8').trim();

export const repositoryKey = (organization, project, repository) => [organization, project, repository].map(part => String(part ?? '').trim().toLowerCase()).join('/');

// A remote of an Azure DevOps repository ends in /_git/<name> (with .git or %20).
export function remoteFor(remotes, repository) {
  const wanted = String(repository).toLowerCase();
  return remotes.find(({ url }) => {
    const match = url.replace(/\/+$/, '').replace(/\.git$/i, '').match(/\/_git\/([^/]+)$/);
    if (!match) return false;
    let name = match[1];
    try { name = decodeURIComponent(name); } catch { /* keep it as written */ }
    return name.toLowerCase() === wanted;
  })?.name ?? null;
}

// The folder must be a clone of that repository, so a review never compares another one.
export async function checkRepository(path, repository) {
  if (typeof path !== 'string' || !path.trim() || !isAbsolute(path.trim())) throw fail('Indica la ruta completa de la carpeta del repositorio.');
  const folder = path.trim();
  if (!(await stat(folder).catch(() => null))?.isDirectory()) throw fail(`No existe la carpeta «${folder}».`);
  const root = await text(folder, ['rev-parse', '--show-toplevel'], { timeout: 15000 }).catch(() => null);
  if (!root) throw fail(`«${folder}» no es un repositorio git.`);
  const remotes = (await text(root, ['remote', '-v'], { timeout: 15000 })).split('\n').map(line => line.split(/\s+/)).filter(([name, url]) => name && url).map(([name, url]) => ({ name, url }));
  const remote = remoteFor(remotes, repository);
  if (!remote) throw fail(`La carpeta «${root}» no es un clon de «${repository}»: ninguno de sus remotos apunta a …/_git/${repository}.`);
  return { path: root, remote };
}

const exists = (cwd, commit) => git(cwd, ['cat-file', '-e', `${commit}^{commit}`], { timeout: 15000 }).then(() => true, () => false);

// Changed files between two commits, as `git diff --name-status -z -M` lists them.
export function parseNameStatus(output) {
  const parts = output.toString('utf8').split('\0').filter(Boolean), changes = [];
  for (let index = 0; index < parts.length;) {
    const status = parts[index++], kind = status[0];
    if (kind === 'R' || kind === 'C') changes.push({ changeType: CHANGE_TYPES[kind], originalPath: parts[index++], path: parts[index++] });
    else changes.push({ changeType: CHANGE_TYPES[kind] ?? 'edit', path: parts[index++] });
  }
  return changes;
}

async function readAt(cwd, commit, path, limit) {
  try {
    const size = Number(await text(cwd, ['cat-file', '-s', `${commit}:${path}`], { timeout: 15000 }));
    if (size > limit) return { tooLarge: true, size };
    return decodeContent(await git(cwd, ['cat-file', 'blob', `${commit}:${path}`], { maxBuffer: limit + 1024 }), size);
  } catch (error) { return { error: error.message }; }
}

// Files of the pull request with the same shape as those read from Azure DevOps:
// paths start with /, so comments anchor to the same lines.
export async function localPullRequestFiles({ path, remote, pullRequest, iteration, limits, onProgress = () => {} }) {
  const branch = ref => String(ref ?? '').replace(/^refs\/heads\//, '');
  const source = iteration?.sourceCommit ?? pullRequest.lastMergeSourceCommit;
  if (!source) throw fail('Azure DevOps no indicó el commit del pull request.');
  onProgress({ message: `Actualizando «${branch(pullRequest.sourceRefName)}» y «${branch(pullRequest.targetRefName)}» en el repositorio local…` });
  const fetched = await git(path, ['fetch', '--no-tags', remote, pullRequest.sourceRefName, pullRequest.targetRefName]).then(() => null, error => error.message);
  if (!(await exists(path, source))) throw fail(`El repositorio local no tiene el commit del pull request (${source.slice(0, 8)})${fetched ? ` y no se pudo actualizar: ${fetched}` : ''}. Haz git fetch en «${path}» y vuelve a intentarlo.`, 409);
  let base = iteration?.baseCommit && await exists(path, iteration.baseCommit) ? iteration.baseCommit : null;
  if (!base) {
    const target = (await exists(path, `${remote}/${branch(pullRequest.targetRefName)}`)) ? `${remote}/${branch(pullRequest.targetRefName)}` : 'FETCH_HEAD';
    base = await text(path, ['merge-base', target, source]).catch(() => null);
    if (!base) throw fail(`No se encontró la base común con «${branch(pullRequest.targetRefName)}» en el repositorio local.`, 409);
  }
  onProgress({ message: 'Calculando el diff en el repositorio local…' });
  const changes = parseNameStatus(await git(path, ['diff', '--name-status', '-z', '-M', base, source]));
  const files = [];
  let budget = limits.totalBytes;
  for (const change of changes.slice(0, limits.files)) {
    const entry = { path: `/${change.path}`, originalPath: change.originalPath ? `/${change.originalPath}` : null, changeType: change.changeType };
    if (budget <= 0) { files.push({ ...entry, before: { skipped: true }, after: { skipped: true } }); continue; }
    const limit = Math.min(limits.fileBytes, budget);
    const before = change.changeType === 'add' ? { text: '' } : await readAt(path, base, change.originalPath ?? change.path, limit);
    const after = change.changeType === 'delete' ? { text: '' } : await readAt(path, source, change.path, limit);
    budget -= (before.size ?? 0) + (after.size ?? 0);
    files.push({ ...entry, before, after });
  }
  return { files, omittedFiles: Math.max(0, changes.length - limits.files), base, source };
}
