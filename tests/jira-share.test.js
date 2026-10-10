import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zip, unzip, safeEntry } from '../server/zip.js';
import { packState, unpackState } from '../server/jira-share.js';
import { TicketStore, ensureWorktree, newTicket } from '../server/jira-agents.js';
import { collectTicket, SHARED, sharedName } from '../server/jira.js';

const temp = async t => { const dir = await mkdtemp(join(tmpdir(), 'neo-share-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
const git = (cwd, ...args) => execFileSync('git', args, { cwd }).toString().trim();
async function repository(path, content = 'uno\n') {
  await mkdir(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main'); git(path, 'config', 'user.email', 't@t'); git(path, 'config', 'user.name', 't');
  await writeFile(join(path, 'a.txt'), content); git(path, 'add', '.'); git(path, 'commit', '-qm', 'init');
}

test('a ZIP keeps names, binary content and refuses paths outside the folder', () => {
  const data = Buffer.from([0, 1, 2, 255, 254]);
  const entries = unzip(zip([{ name: 'estado.json', data: Buffer.from('{"a":1}') }, { name: 'evidencias/captura ñ.png', data }, { name: 'vacío.md', data: Buffer.alloc(0) }]));
  assert.deepEqual(entries.map(e => [e.name, e.data.length]), [['estado.json', 7], ['evidencias/captura ñ.png', 5], ['vacío.md', 0]]);
  assert.deepEqual(entries[1].data, data);
  for (const bad of ['../x', '/etc/x', 'C:/x', 'a//b', 'con.txt', 'a/b.', 'a\\..\\b']) assert.throws(() => safeEntry(bad), /ruta no válida/, bad);
  assert.throws(() => unzip(Buffer.from('nada')), /no es un ZIP/);
});

test('the shared state of a ticket is downloaded apart and goes on where another computer left it', async t => {
  const dir = await temp(t);
  // Two computers with a clone of the same repository.
  await repository(join(dir, 'origen'));
  execFileSync('git', ['clone', '-q', join(dir, 'origen'), join(dir, 'b-repo')]);
  const settingsA = { repository: join(dir, 'origen') }, settingsB = { repository: join(dir, 'b-repo') };
  const a = new TicketStore(join(dir, 'a')), b = new TicketStore(join(dir, 'b'));

  const folderA = a.folder('NEO-1');
  await a.update('NEO-1', () => ({ ...newTicket({ key: 'NEO-1', summary: 'Falla' }), stage: 'verify', status: 'pending', iterations: 1, history: [{ stage: 'fix', number: 1, outcome: 'fixed', report: 'solucion-1.md', log: 'registros/solucionar-1.log' }], assignee: { id: 'ana', name: 'Ana', me: true }, archived: false }));
  await writeFile(join(folderA, 'solucion-1.md'), 'Corregido el redondeo');
  await mkdir(join(folderA, 'registros')); await writeFile(join(folderA, 'registros', 'solucionar-1.log'), 'log');
  await mkdir(join(folderA, 'evidencias')); await writeFile(join(folderA, 'evidencias', 'antes.png'), Buffer.from([137, 80, 78, 71, 0, 255]));
  await mkdir(join(folderA, 'adjuntos')); await writeFile(join(folderA, 'adjuntos', 'video.mp4'), 'grande');
  await writeFile(join(folderA, 'descripcion.md'), '# NEO-1');
  const { path: codeA } = await ensureWorktree(settingsA, { key: 'NEO-1' }, folderA);
  await writeFile(join(codeA, 'a.txt'), 'uno corregido\n'); await writeFile(join(codeA, 'nuevo.txt'), 'nuevo\n');
  await writeFile(join(codeA, 'icono.bin'), Buffer.from([0, 1, 2, 3, 255]));

  const pack = await packState(a, 'NEO-1', { by: 'Ana' });
  const names = unzip(pack.data).map(e => e.name).sort();
  assert.deepEqual(names, ['codigo.patch', 'estado.json', 'evidencias/antes.png', 'neo-team.json', 'registros/solucionar-1.log', 'solucion-1.md'], 'what comes from Jira and the code itself do not travel');
  assert.deepEqual(git(codeA, 'status', '--porcelain').split('\n').sort(), ['?? icono.bin', '?? nuevo.txt', 'M a.txt'], 'the worktree is left as it was, nothing staged');

  // The other computer has the ticket only collected, with a change of its own.
  const folderB = b.folder('NEO-1');
  await b.update('NEO-1', () => ({ ...newTicket({ key: 'NEO-1', summary: 'Falla (Jira)' }), stage: 'analyze', history: [{ stage: 'collect', number: 1, outcome: 'ok', report: 'resumen.md' }], assignee: { id: 'ana', name: 'Ana', me: false }, archived: false, autoLock: true }));
  await writeFile(join(folderB, 'resumen.md'), 'mío'); await writeFile(join(folderB, 'descripcion.md'), '# NEO-1 de Jira');
  const { path: codeB } = await ensureWorktree(settingsB, { key: 'NEO-1' }, folderB);
  await writeFile(join(codeB, 'a.txt'), 'cambio local\n');

  const resumed = await unpackState({ tickets: b, key: 'NEO-1', data: pack.data, settings: settingsB, me: { id: 'luis' } });
  assert.deepEqual(resumed.warnings, []);
  const ticket = await b.get('NEO-1');
  assert.deepEqual([ticket.stage, ticket.iterations, ticket.history.map(h => h.stage), ticket.summary, ticket.autoLock, ticket.assignee.me, ticket.resumedFrom.by], ['verify', 1, ['fix'], 'Falla (Jira)', true, false, 'Ana'], 'the work comes from there; what Jira says and the board of this person stay');
  assert.equal(await readFile(join(folderB, 'solucion-1.md'), 'utf8'), 'Corregido el redondeo');
  assert.deepEqual(await readFile(join(folderB, 'evidencias', 'antes.png')), Buffer.from([137, 80, 78, 71, 0, 255]));
  assert.equal(await stat(join(folderB, 'resumen.md')).catch(() => null), null, 'the reports of this computer give way to the shared ones');
  assert.equal(await readFile(join(folderB, 'descripcion.md'), 'utf8'), '# NEO-1 de Jira', 'what was downloaded from Jira stays');
  assert.equal(await readFile(join(codeB, 'a.txt'), 'utf8'), 'uno corregido\n');
  assert.equal(await readFile(join(codeB, 'nuevo.txt'), 'utf8'), 'nuevo\n');
  assert.deepEqual(await readFile(join(codeB, 'icono.bin')), Buffer.from([0, 1, 2, 3, 255]));
  assert.equal(git(codeB, 'diff', '--cached', '--name-only'), '', 'nothing left staged');

  // What there was here is kept, code changes included.
  const backup = unzip(await readFile(resumed.backup));
  assert.equal(backup.find(e => e.name === 'resumen.md').data.toString(), 'mío');
  assert.match(backup.find(e => e.name === 'codigo.patch').data.toString(), /\+cambio local/);
  assert.deepEqual(await readdir(join(dir, 'b')), ['NEO-1', 'copias']);
  assert.deepEqual((await b.list()).map(x => x.key), ['NEO-1'], 'the copies are not a ticket');

  await assert.rejects(unpackState({ tickets: b, key: 'NEO-2', data: pack.data, settings: settingsB }), /no es un estado de NEO-2/);
});

test('code changes that do not fit, or without a repository, stay as a patch in the folder', async t => {
  const dir = await temp(t);
  await repository(join(dir, 'a-repo'));
  await repository(join(dir, 'b-repo'), 'otra cosa distinta\n');
  const a = new TicketStore(join(dir, 'a')), b = new TicketStore(join(dir, 'b'));
  await a.update('NEO-3', () => ({ ...newTicket({ key: 'NEO-3' }), stage: 'build', history: [{ stage: 'fix', number: 1, outcome: 'fixed' }] }));
  const { path } = await ensureWorktree({ repository: join(dir, 'a-repo') }, { key: 'NEO-3' }, a.folder('NEO-3'));
  await writeFile(join(path, 'a.txt'), 'uno arreglado\n');
  const { data } = await packState(a, 'NEO-3');

  const conflict = await unpackState({ tickets: b, key: 'NEO-3', data, settings: { repository: join(dir, 'b-repo') } });
  assert.match(conflict.warnings.join(' '), /no encajan[\s\S]*codigo\.patch/);
  assert.match(await readFile(join(b.folder('NEO-3'), 'codigo.patch'), 'utf8'), /\+uno arreglado/);
  assert.equal(await readFile(join(b.folder('NEO-3'), 'codigo', 'a.txt'), 'utf8'), 'otra cosa distinta\n', 'the worktree is left clean, without conflict marks');
  assert.equal((await b.get('NEO-3')).stage, 'build');
  assert.equal(conflict.backup, null, 'nothing to keep from a ticket that was not here');

  const none = await unpackState({ tickets: new TicketStore(join(dir, 'c')), key: 'NEO-3', data, settings: {} });
  assert.match(none.warnings.join(' '), /No hay repositorio configurado/);
});

test('the shared state is not downloaded with the attachments of the ticket', async t => {
  const folder = join(await temp(t), 'NEO-1'), downloaded = [];
  const attachment = (id, filename, created) => ({ id, filename, created, size: 1, author: { displayName: 'Ana' }, content: `https://e/${id}` });
  const client = {
    issue: async () => ({ key: 'NEO-1', fields: { summary: 'x', attachment: [attachment(1, 'a.png', '2026-01-01'), attachment(2, sharedName('NEO-1'), '2026-01-02'), attachment(3, sharedName('NEO-1'), '2026-01-03')] } }),
    comments: async () => [], download: async url => { downloaded.push(url); return new Response('x'); },
  };
  const meta = await collectTicket({ client, settings: { url: 'https://e' }, key: 'NEO-1', folder });
  assert.deepEqual([meta.attachments, downloaded, meta.shared.id, meta.shared.author], [1, ['https://e/1'], '3', 'Ana'], 'only the latest state counts');
  assert.doesNotMatch(await readFile(join(folder, 'descripcion.md'), 'utf8'), /neo-team-estado/);
  assert.ok(SHARED.test('neo-team-estado-NEO-1.zip'));
});
