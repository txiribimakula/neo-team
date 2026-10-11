// Revisar: the fix of a ticket goes to Azure DevOps as a draft pull request and its
// review as comments on it. The worktree is never committed: the code reviewed is
// a snapshot of it (through a copy of its index), pushed as a commit on top of the
// ticket's remote branch, so the agents' «no commits» and the shared patch of the
// ticket stay as they were. Every comment has to be answered by the fix, or left
// for the verification when only a manual test can confirm it.
import { execFile } from 'node:child_process';
import { copyFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function git(cwd, args, { env = {}, timeout = 5 * 60000 } = {}) {
  return new Promise((done, reject) => execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', ...args], { cwd, timeout, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } },
    (error, stdout, stderr) => error ? reject(new Error(String(stderr || error.message).trim().split('\n').slice(-3).join(' ').slice(0, 400) || 'git falló.')) : done(stdout)));
}
const text = async (cwd, args, options) => (await git(cwd, args, options)).toString('utf8').trim();

// --- Code -----------------------------------------------------------------------

// The worktree as it is now, new files included: its commit and the tree of its files.
export async function snapshot(path) {
  const base = await text(path, ['rev-parse', 'HEAD']);
  const index = resolve(path, await text(path, ['rev-parse', '--git-path', 'index']));
  const temp = join(tmpdir(), `neo-team-index-${randomUUID()}`);
  try {
    // The copy keeps the date of the index, or git would take for unchanged the
    // files changed in the same second it was written (with the same size).
    const dates = await stat(index).catch(() => null);
    if (dates) { await copyFile(index, temp); await utimes(temp, dates.atime, dates.mtime); }
    const env = { GIT_INDEX_FILE: temp };
    await git(path, ['add', '-A'], { env });
    return { base, tree: await text(path, ['write-tree'], { env }) };
  } finally { await rm(temp, { force: true }); }
}
export const treeOf = (path, commit) => text(path, ['rev-parse', `${commit}^{tree}`]);
export async function diffText(path, from, to) {
  const out = await text(path, ['diff', '--no-color', '--no-ext-diff', '-M', from, to]);
  return out.length > 400000 ? `${out.slice(0, 400000)}\n… (diff truncado)` : out;
}
export async function changedFiles(path, from, to) {
  return (await git(path, ['diff', '--name-only', '-z', '-M', from, to])).toString('utf8').split('\0').filter(Boolean);
}

// https://dev.azure.com/{org}/{project}/_git/{repo}, {org}.visualstudio.com/… and
// their SSH forms. A repository named like its project may omit the project.
export function azureRepository(url) {
  const dec = part => { try { return decodeURIComponent(part); } catch { return part; } };
  const value = String(url ?? '').trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const ssh = value.match(/^(?:[^@/]+@)?(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com):v3\/([^/]+)\/([^/]+)\/([^/]+)$/i);
  if (ssh) return { organization: dec(ssh[1]), project: dec(ssh[2]), repository: dec(ssh[3]) };
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  const host = parsed.hostname.toLowerCase(), parts = parsed.pathname.split('/').filter(Boolean).map(dec), at = parts.indexOf('_git');
  if (at < 0 || at !== parts.length - 2) return null;
  const organization = host === 'dev.azure.com' ? parts[0] : host.endsWith('.visualstudio.com') ? host.slice(0, -'.visualstudio.com'.length) : null;
  const project = parts[at - 1];
  if (!organization || (host === 'dev.azure.com' && at < 1)) return null;
  const repository = parts[at + 1];
  return { organization, project: !project || (host === 'dev.azure.com' && at === 1) || /^DefaultCollection$/i.test(project) ? repository : project, repository };
}
// The remote of the worktree that is an Azure DevOps repository, «origin» first.
export async function azureRemote(path) {
  const remotes = (await text(path, ['remote', '-v'], { timeout: 15000 })).split('\n').map(line => line.split(/\s+/)).filter(([name, url, kind]) => name && url && kind !== '(push)');
  remotes.sort((a, b) => (b[0] === 'origin') - (a[0] === 'origin'));
  for (const [name, url] of remotes) { const repo = azureRepository(url); if (repo) return { name, ...repo }; }
  throw fail('El repositorio no tiene un remoto de Azure DevOps (…/_git/<repositorio>): Revisar publica allí el pull request.');
}

// The tree reviewed goes on top of the ticket's remote branch (as a merge with the
// worktree's base when that base is newer), so pushing never rewrites it. Nothing
// is pushed when the branch already has that tree.
export async function publishCode({ path, remote, branch, base, tree, message }) {
  const listed = await text(path, ['ls-remote', '--heads', remote, `refs/heads/${branch}`], { timeout: 2 * 60000 })
    .catch(error => { throw fail(`No se pudo consultar «${remote}»: ${error.message}`); });
  const tip = listed.split(/\s+/)[0] || null;
  if (tip && !(await git(path, ['cat-file', '-e', `${tip}^{commit}`]).then(() => true, () => false))) await git(path, ['fetch', '--no-tags', remote, `refs/heads/${branch}`], { timeout: 10 * 60000 });
  if (tip && await treeOf(path, tip) === tree) return { commit: tip, pushed: false };
  const newer = tip && !(await git(path, ['merge-base', '--is-ancestor', base, tip]).then(() => true, () => false));
  const parents = tip ? [tip, ...(newer ? [base] : [])] : [base];
  const commit = await text(path, ['commit-tree', tree, ...parents.flatMap(p => ['-p', p]), '-m', message])
    .catch(error => { throw fail(/tell me who you are|user\.(name|email)|identity/i.test(error.message) ? 'Configura tu nombre y correo en git (git config --global user.name / user.email) para publicar el código.' : `No se pudo preparar el commit: ${error.message}`); });
  await git(path, ['push', remote, `${commit}:refs/heads/${branch}`], { timeout: 10 * 60000 })
    .catch(error => { throw fail(`No se pudo subir la rama ${branch}: ${error.message}`); });
  return { commit, pushed: true };
}

// --- Comments -----------------------------------------------------------------

export const SEVERITIES = ['blocker', 'major', 'minor', 'suggestion', 'check'];
export const SEVERITY_LABELS = { blocker: 'Blocker', major: 'Major', minor: 'Minor', suggestion: 'Suggestion', check: 'Check' };
export const ANSWERS = ['changed', 'declined', 'verify'];
const ANSWER_LABELS = { changed: 'Changed', declined: 'Not changed', verify: 'Left for the manual verification', person: 'Done by hand' };
// Azure DevOps thread status after each answer.
const THREAD_STATUS = { changed: 'fixed', declined: 'wontFix', verify: 'active' };
export const severityOf = c => c.severity === 'check' && c.manual ? 'Check (manual test)' : SEVERITY_LABELS[c.severity] ?? 'Minor';

// Where each comment is: waiting for the fix, left for the verification or answered
// (also by the person, with ⏩).
export function commentState(comment) {
  const last = (comment.answers ?? []).at(-1);
  if (!last) return 'open';
  if (last.action === 'verify') return 'deferred';
  if (last.action === 'checked') return last.ok ? 'answered' : 'open';
  return 'answered';
}
export const commentsIn = (review, state) => (review?.comments ?? []).filter(c => commentState(c) === state);

// What the reviewer reports, checked: short texts, a known severity, a manual test
// only for checks, and a thread only of an earlier comment.
export function reviewComments(input, existing = []) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 30).flatMap(item => {
    const body = String(item?.text ?? '').trim().replace(/\s+\n/g, '\n').slice(0, 1000);
    if (!body || !SEVERITIES.includes(item?.severity)) return [];
    const file = String(item.file ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '').slice(0, 500) || null;
    const line = file && Number.isInteger(item.line) && item.line > 0 ? item.line : null;
    const replyTo = existing.find(c => c.id === item.replyTo && c.thread) ?? null;
    return [{ severity: item.severity, text: body, file, line, manual: item.severity === 'check' && item.manual === true, ...(replyTo ? { thread: replyTo.thread, replyTo: replyTo.id } : {}) }];
  });
}
export function commentText(comment, changed = []) {
  const where = comment.file && !comment.thread && !changed.includes(comment.file) ? `\`${comment.file}${comment.line ? `:${comment.line}` : ''}\` · ` : '';
  return `**${severityOf(comment)}:** ${where}${comment.text}`;
}
export function answerText(answer) {
  if (answer.action === 'checked') return `**${answer.ok ? 'Verified' : 'Still failing'}:** ${answer.text}`;
  return `**${ANSWER_LABELS[answer.action] ?? 'Answer'}:** ${answer.text}`;
}
const answerStatus = answer => answer.action === 'checked' ? (answer.ok ? 'fixed' : 'active') : THREAD_STATUS[answer.action] ?? 'active';

// The comments to answer and the checks to do, as the agents read them.
export function commentsBlock(comments, { answers = true } = {}) {
  return comments.map(c => `- ${c.id} [${severityOf(c)}] ${c.file ? `${c.file}${c.line ? `:${c.line}` : ''}` : 'general'}${c.replyTo ? ` (about ${c.replyTo})` : ''}: ${c.text.replace(/\n/g, ' ')}${answers && c.answers?.length ? `\n${c.answers.map(a => `  ${a.stage === 'verify' ? 'Verification' : 'Fix'}: ${answerText(a).replace(/\*\*/g, '')}`).join('\n')}` : ''}`).join('\n');
}

// Publishes what is still only local: the comments of the review (each in its own
// thread, or as a reply in the thread it follows) and the answers of the fix and the
// verification, which also set the status of their thread. Each one is recorded as
// soon as it is in Azure DevOps, so nothing is sent twice.
export async function publishPending({ hub, review, changed = [], save, onActivity = () => {} }) {
  const pr = review.pullRequest, target = { organization: pr.organization, project: pr.project, repositoryId: pr.repositoryId, pullRequestId: pr.id };
  for (const comment of review.comments) {
    if (comment.posted) continue;
    const content = commentText(comment, changed);
    const thread = comment.thread
      ? (await hub.reply({ ...target, threadId: comment.thread, content, status: 'active' }), comment.thread)
      : (await hub.comment({ ...target, content, ...(comment.file && changed.includes(comment.file) ? { filePath: `/${comment.file}`, ...(comment.line ? { line: comment.line } : {}) } : {}) })).id;
    await save(c => c.id === comment.id ? { ...c, thread, posted: true } : c);
    Object.assign(comment, { thread, posted: true });
    onActivity({ kind: 'result', message: `Comentario ${comment.id} publicado en el pull request ${pr.id}.` });
  }
  for (const comment of review.comments) {
    if (!comment.thread) continue;
    for (const [index, answer] of (comment.answers ?? []).entries()) {
      if (answer.posted) continue;
      await hub.reply({ ...target, threadId: comment.thread, content: answerText(answer), status: answerStatus(answer) });
      await save(c => c.id === comment.id ? { ...c, answers: c.answers.map((a, i) => i === index ? { ...a, posted: true } : a) } : c);
      answer.posted = true;
      onActivity({ kind: 'result', message: `Respuesta a ${comment.id} publicada en el pull request ${pr.id}.` });
    }
  }
}

// --- Azure DevOps ---------------------------------------------------------------

// Pull requests through the same Azure DevOps connection as the rest of Neo Team:
// the repository has to be of the connected organization.
export class AzureReviewHub {
  constructor({ azure, config }) { this.azure = azure; this.config = config; }
  async connect(target) {
    const config = this.config();
    if (!config?.organization) throw Object.assign(fail('Conecta Azure DevOps para publicar el pull request.'), { reason: 'azure' });
    if (config.organization.toLowerCase() !== String(target.organization).toLowerCase()) throw fail(`El repositorio es de la organización «${target.organization}» y Neo Team está conectado a «${config.organization}».`);
    await this.azure.open(config);
    return { ...config, project: target.project };
  }
  async create(target) {
    const config = await this.connect(target);
    return this.azure.createPullRequest(config, target);
  }
  async comment(target) { return this.azure.addPullRequestComment(await this.connect(target), target); }
  async reply(target) { return this.azure.replyPullRequestComment(await this.connect(target), target); }
}
export const pullRequestLink = ({ organization, project, repository }, id) =>
  `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}/pullrequest/${id}`;

// The example: pull requests and comments only in memory of this process.
export class DemoReviewHub {
  constructor() { this.next = 400; this.threads = new Map(); this.prs = new Map(); }
  async create(target) {
    const known = this.prs.get(target.sourceRefName);
    if (known) return { ...known, created: false };
    const pr = { pullRequestId: this.next++, repositoryId: '00000000-0000-0000-0000-000000000001', targetRefName: 'refs/heads/main' };
    this.prs.set(target.sourceRefName, pr);
    return { ...pr, created: true };
  }
  async comment({ content }) { const id = this.next++; this.threads.set(id, [content]); return { id }; }
  async reply({ threadId, content, status }) { this.threads.set(threadId, [...(this.threads.get(threadId) ?? []), content]); return { status }; }
}
