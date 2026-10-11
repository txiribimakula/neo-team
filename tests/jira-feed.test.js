import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityFeed, curate, split } from '../server/jira-feed.js';
import { feedView, generalView } from '../dist/jira.js';

const temp = async t => { const dir = await mkdtemp(join(tmpdir(), 'neo-feed-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };

test('only what matters becomes a line, with the long part folded', () => {
  assert.equal(curate({ kind: 'note', message: 'Preparando archivos y entorno…' }), null, 'the pipeline notes stay in the step log');
  assert.equal(curate({ kind: 'tool', message: 'progreso', toolId: 't1' }), null, 'tool progress is not a line');
  assert.deepEqual(curate({ kind: 'person', message: 'Tú: sigue' }), { family: 'person', title: 'sigue', detail: '' });
  assert.deepEqual(curate({ kind: 'warning', message: 'Rechazado: curl' }), { family: 'warning', title: 'Rechazado: curl', detail: '' });
  assert.deepEqual(curate({ kind: 'info', source: 'intent', message: 'Leyendo el código' }).family, 'ai');
  const long = split(`Resumen\n${'x'.repeat(10)}`);
  assert.deepEqual([long.title, long.detail.startsWith('Resumen\n')], ['Resumen', true], 'the first line is the title');
  assert.equal(split('a'.repeat(300)).title.length, 160);
});

test('a tool is one line that ends with its result, and outputs go on in one line', async t => {
  const dir = await temp(t), feed = new ActivityFeed(join(dir, 'actividad.json'));
  await feed.ready;
  feed.activity({ kind: 'tool', toolId: 'c1', phase: 'start', title: 'shell: dotnet test' }, { key: 'NEO-1', stage: 'fix' });
  assert.deepEqual(feed.recent().map(i => [i.family, i.title, i.status, i.key]), [['tool', 'shell: dotnet test', 'running', 'NEO-1']]);
  feed.activity({ kind: 'warning', toolId: 'c1', phase: 'end', title: 'shell: dotnet test', ok: false, seconds: '2.5', detail: '1 prueba falla' });
  assert.deepEqual(feed.recent().map(i => [i.title, i.status, i.meta, i.detail]), [['shell: dotnet test', 'failed', '2.5 s', '1 prueba falla']], 'the same line, finished');
  feed.activity({ kind: 'output', message: 'línea 1' }, { key: 'NEO-1' });
  feed.activity({ kind: 'output', message: 'línea 2' }, { key: 'NEO-1' });
  assert.deepEqual(feed.recent().slice(1).map(i => [i.title, i.detail]), [['Salida', 'línea 1\nlínea 2']]);
  feed.activity({ kind: 'note', message: 'sigue en curso' });
  assert.equal(feed.recent().length, 2);
  // Kept on disk: a new feed reads it, and a tool cut by closing is shown as not finished.
  feed.activity({ kind: 'tool', toolId: 'c2', phase: 'start', title: 'shell: build' });
  feed.save(); await new Promise(done => setTimeout(done, 500)); await feed.saving;
  const again = new ActivityFeed(join(dir, 'actividad.json'));
  again.add({ family: 'person', title: 'Empezar' });
  await again.ready;
  assert.deepEqual(again.recent().map(i => [i.id, i.title, i.status]), [['1', 'shell: dotnet test', 'failed'], ['2', 'Salida', undefined], ['3', 'shell: build', 'stopped'], ['4', 'Empezar', undefined]], 'what was added while reading goes after it');
});

test('the feed reads newest first, coloured by family, and folds what is long', () => {
  const html = feedView([
    { id: '1', at: 0, family: 'step', key: 'NEO-1', stage: 'fix', title: 'Solucionar · Corregido', meta: '2 min', detail: '# Informe\n\nCambiado **Exportador.cs**' },
    { id: '2', at: 0, family: 'tool', key: 'NEO-1', stage: 'fix', title: 'shell: dotnet build', status: 'running' },
    { id: '3', at: 0, family: 'jira', title: 'Comentario publicado', detail: '*Neo Team*' },
  ], new Set(['1']));
  assert.deepEqual([...html.matchAll(/<li class="feed feed-(\w+)"/g)].map(m => m[1]), ['jira', 'tool', 'step'], 'newest first');
  assert.match(html, /<li class="feed feed-tool" title="Lo que hace la IA"><div class="feed-row"><time>[^<]+<\/time><span class="feed-key">NEO-1<\/span><span class="feed-title"[^>]*>shell: dotnet build<\/span><small>Solucionar<\/small><span class="spinner"/, 'a running tool, with its step');
  assert.match(html, /<details data-feed="1" open><summary>[\s\S]*Solucionar · Corregido[\s\S]*<small>2 min<\/small><\/summary><div class="feed-md jira-md">[\s\S]*<strong>Exportador\.cs<\/strong>/, 'a report, open as it was left, in Markdown');
  assert.match(html, /<details data-feed="3"><summary>[\s\S]*<\/summary><pre>\*Neo Team\*<\/pre>/, 'a Jira comment as it is sent');
  assert.equal(feedView([]), '');
});

test('folded, the assistant counts what is new', () => {
  const folded = unread => generalView({ conversation: null, activity: [] }, '', false, null, true, [], new Set(), {}, unread);
  assert.match(folded(3), /title="Mostrar el asistente · 3 novedades"[\s\S]*<span class="jira-side-count" aria-hidden="true">3<\/span>/);
  assert.match(folded(120), />99\+<\/span>/);
  assert.doesNotMatch(folded(0), /jira-side-count/);
  assert.match(generalView({ conversation: 'waiting', activity: [] }, '', false, null, true, [], new Set(), {}, 0), /jira-side-dot[\s\S]*/, 'without news, the dot still says it waits for you');
});
