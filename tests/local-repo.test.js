import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, unlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRepository, localPullRequestFiles, parseNameStatus, remoteFor, repositoryKey } from '../server/local-repo.js';
import { buildDiff, runReview, LIMITS } from '../server/pr-review.js';

const run = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Neo', '-c', 'user.email=neo@example.test', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();

// An "Azure" remote at …/_git/web, the clone where the pull request is made, and
// the person's clone, which only sees the last commit of the pull request after a fetch.
async function repositories(t) {
  const root = await mkdtemp(join(tmpdir(), 'neo-local-repo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, 'org', '_git', 'web');
  await mkdir(remote, { recursive: true });
  run(remote, 'init', '--bare', '-q');
  const author = join(root, 'author');
  run(root, 'clone', '-q', remote, author);
  await writeFile(join(author, 'app.js'), 'const a = 1;\nconst b = 2;\n');
  await writeFile(join(author, 'old-name.js'), 'export const value = 1;\nexport const other = 2;\nexport const third = 3;\n');
  await writeFile(join(author, 'removed.txt'), 'bye\n');
  await writeFile(join(author, 'query.sql'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('SELECT 1;\n', 'utf16le')]));
  run(author, 'add', '-A'); run(author, 'commit', '-qm', 'base'); run(author, 'push', '-q', 'origin', 'main');
  const base = run(author, 'rev-parse', 'HEAD');
  run(author, 'checkout', '-qb', 'feature/x');
  await writeFile(join(author, 'app.js'), 'const a = 1;\nconst b = 3;\n');
  await rename(join(author, 'old-name.js'), join(author, 'new-name.js'));
  await unlink(join(author, 'removed.txt'));
  await mkdir(join(author, 'src'));
  await writeFile(join(author, 'src', 'nuevo archivo.js'), 'console.log("hola");\n');
  await writeFile(join(author, 'query.sql'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('SELECT 2;\n', 'utf16le')]));
  run(author, 'add', '-A'); run(author, 'commit', '-qm', 'feature'); run(author, 'push', '-q', 'origin', 'feature/x');
  const mine = join(root, 'mine');
  run(root, 'clone', '-q', remote, mine);
  await writeFile(join(author, 'app.js'), 'const a = 1;\nconst b = 4;\n');
  run(author, 'commit', '-qam', 'later'); run(author, 'push', '-q', 'origin', 'feature/x');
  return { root, remote, mine, base, source: run(author, 'rev-parse', 'HEAD') };
}
const pullRequest = { pullRequestId: 7, title: 'Cambio', sourceRefName: 'refs/heads/feature/x', targetRefName: 'refs/heads/main', repository: { id: 'r1', name: 'web' } };

test('a local folder must be a clone of that Azure DevOps repository', async t => {
  const { root, mine } = await repositories(t);
  assert.deepEqual(await checkRepository(join(mine, ''), 'web'), { path: run(mine, 'rev-parse', '--show-toplevel'), remote: 'origin' });
  await assert.rejects(() => checkRepository(mine, 'otro'), /no es un clon de «otro»/);
  await assert.rejects(() => checkRepository('relativa/carpeta', 'web'), /ruta completa/);
  await assert.rejects(() => checkRepository(join(root, 'no-existe'), 'web'), /No existe la carpeta/);
  await assert.rejects(() => checkRepository(root, 'web'), /no es un repositorio git/);
  assert.equal(remoteFor([{ name: 'origin', url: 'https://org@dev.azure.com/org/Proyecto/_git/Mi%20Repo' }], 'mi repo'), 'origin');
  assert.equal(remoteFor([{ name: 'azure', url: 'git@ssh.dev.azure.com:v3/org/Proyecto/web' }, { name: 'up', url: 'https://org.visualstudio.com/P/_git/web.git' }], 'web'), 'up');
  assert.equal(repositoryKey('Org', 'Proyecto', 'Web'), 'org/proyecto/web');
});

test('the pull request is compared locally between its common base and its commit, after fetching it', async t => {
  const { mine, base, source } = await repositories(t);
  const messages = [];
  const result = await localPullRequestFiles({ path: mine, remote: 'origin', pullRequest, iteration: { sourceCommit: source, baseCommit: base }, limits: LIMITS, onProgress: p => messages.push(p.message) });
  assert.match(messages[0], /feature\/x.*main/);
  const byPath = Object.fromEntries(result.files.map(f => [f.path, f]));
  assert.deepEqual(Object.keys(byPath).sort(), ['/app.js', '/new-name.js', '/query.sql', '/removed.txt', '/src/nuevo archivo.js']);
  assert.equal(byPath['/app.js'].after.text, 'const a = 1;\nconst b = 4;\n', 'the last commit of the pull request, fetched');
  assert.deepEqual([byPath['/new-name.js'].changeType, byPath['/new-name.js'].originalPath], ['rename', '/old-name.js']);
  assert.equal(byPath['/removed.txt'].changeType, 'delete');assert.equal(byPath['/src/nuevo archivo.js'].changeType, 'add');
  assert.equal(byPath['/query.sql'].after.text, 'SELECT 2;\n', 'UTF-16 files are text');
  const diff = buildDiff(result.files);
  assert.deepEqual(diff.files.find(f => f.path === '/app.js').lines, [1, 2]);
  assert.match(diff.text, /\+    2 \| const b = 4;/);
});

test('without the commit of the pull request, or without a base, it says what to do', async t => {
  const { mine, base } = await repositories(t);
  await assert.rejects(() => localPullRequestFiles({ path: mine, remote: 'origin', pullRequest: { ...pullRequest, sourceRefName: 'refs/heads/no-existe' }, iteration: { sourceCommit: 'f'.repeat(40), baseCommit: base }, limits: LIMITS }),
    error => error.status === 409 && /no tiene el commit del pull request \(ffffffff\) y no se pudo actualizar/.test(error.message));
  const source = run(mine, 'rev-parse', 'origin/feature/x');
  const result = await localPullRequestFiles({ path: mine, remote: 'origin', pullRequest, iteration: { sourceCommit: source, baseCommit: null }, limits: LIMITS });
  assert.ok(result.files.length > 0, 'without the base from Azure, the merge base is calculated');assert.equal(result.base, base);
});

test('a review with a local folder asks Azure only for the pull request and its comments', async t => {
  const { mine, base, source } = await repositories(t);
  const calls = [];
  const azure = { pullRequest: async (_config, repository, id, options) => { calls.push(options); return { pullRequest, iteration: { id: 3, sourceCommit: source, baseCommit: base }, files: [], threads: [{ filePath: '/app.js', line: 2, comments: [{ content: 'Ya comentado' }] }] }; } };
  let prompt;
  const reviewer = { status: async () => ({ isAuthenticated: true }), review: async args => { prompt = args.prompt; return { text: JSON.stringify({ summary: 'Bien', verdict: 'comment', findings: [{ file: '/app.js', line: 2, severity: 'major', title: 'b cambia', body: 'Revisa b.' }] }) }; } };
  const review = await runReview({ azure, reviewer, config: { organization: 'org' }, target: { project: 'P', repository: 'web', pullRequestId: 7 }, mode: 'azure', local: { path: mine, remote: 'origin' } });
  assert.deepEqual(calls, [{ includeFiles: false, includeThreads: true }]);
  assert.match(prompt, /const b = 4/);assert.match(prompt, /Ya comentado/);
  assert.deepEqual(review.diffSource, { kind: 'local', path: mine });
  assert.equal(review.pullRequest.sourceCommit, source, 'publishing checks the same commit');
  assert.deepEqual([review.findings[0].file, review.findings[0].line], ['/app.js', 2]);
});

test('renamed and copied files are read from git name-status output', () => {
  assert.deepEqual(parseNameStatus(Buffer.from('M\0a.js\0R087\0old.js\0new.js\0A\0dir/b c.js\0D\0gone.txt\0')), [
    { changeType: 'edit', path: 'a.js' }, { changeType: 'rename', originalPath: 'old.js', path: 'new.js' }, { changeType: 'add', path: 'dir/b c.js' }, { changeType: 'delete', path: 'gone.txt' },
  ]);
});
