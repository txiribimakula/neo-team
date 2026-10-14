// Pipelines: the last run of each pipeline of the project and the reviews of GitHub
// Copilot: why a run failed or, when it succeeded, how to improve the pipeline.
import { aiChoice, effortName } from './ai-choice.js';
import { markdown } from './jira.js';
import { loginView } from './reviews.js';
import { normalize, matchesQuery } from './search.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = value => value ? new Date(value).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const branch = ref => String(ref ?? '').replace(/^refs\/heads\//, '');
const folder = path => String(path ?? '').replace(/^\\+/, '').replace(/\\/g, ' / ');
const elapsed = (start, finish) => start && finish ? Math.max(0, Date.parse(finish) - Date.parse(start)) : null;
export function duration(ms) {
  if (ms === null || !Number.isFinite(ms)) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}` : `${Math.floor(s / 3600)} h${Math.round(s % 3600 / 60) ? ` ${Math.round(s % 3600 / 60)} min` : ''}`;
}
export const RESULT_LABELS = { succeeded: 'Correcta', partiallySucceeded: 'Parcial', failed: 'Fallida', canceled: 'Cancelada', inProgress: 'En curso', notStarted: 'En cola', cancelling: 'Cancelando', postponed: 'Aplazada' };
export const PRIORITY_LABELS = { high: 'Alta', medium: 'Media', low: 'Baja' };
export const CATEGORY_LABELS = { code: 'Código', tests: 'Pruebas', configuration: 'Configuración del pipeline', dependencies: 'Dependencias', infrastructure: 'Infraestructura o agente', intermittent: 'Intermitente', unknown: 'Causa sin determinar' };
const status = run => !run ? 'none' : run.status === 'completed' ? run.result ?? 'none' : run.status ?? 'none';
const statusPill = run => `<span class="pill pipeline-status status-${escape(status(run))}">${escape(RESULT_LABELS[status(run)] ?? 'Sin ejecuciones')}</span>`;
const reviewLabel = run => run?.result === 'succeeded' ? 'Busca cómo hacerlo más rápido y fiable' : 'Busca por qué falló';
const link = (url, label) => url ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${label} ↗</a>` : label;
// The analyses of a pipeline, the newest first.
export const analysesOf = (state, pipelineId) => (state.pipelineAnalyses ?? []).filter(a => a.pipeline.id === pipelineId);

// The code a review reads: the pipeline's repository or another one of the project, and its local clone.
// Keyed by the organization and project the list was read from (the example has its own).
const key = (...parts) => parts.map(part => String(part ?? '').trim().toLowerCase()).join('/');
export const sourceRepository = (state, snapshot, pipeline) => state.pipelineSources?.[key(snapshot.organization, snapshot.project, pipeline.id)] ?? pipeline.repository?.name ?? '';
function sourceView(state, snapshot, pipeline) {
  const chosen = sourceRepository(state, snapshot, pipeline), own = pipeline.repository?.name ?? '', demo = state.mode === 'demo';
  const names = [...new Set([...(own ? [own] : []), ...(snapshot.repositories ?? []).map(r => r.name)])];
  const local = state.localRepositories?.[key(snapshot.organization, snapshot.project, chosen)] ?? '';
  const options = names.map(name => `<option value="${escape(name)}" ${name === chosen ? 'selected' : ''}>${escape(name)}${name === own ? ' · del pipeline' : ''}</option>`).join('');
  return `<div class="pipeline-source"><label class="form-field">Código<select data-pipeline-repository="${pipeline.id}" title="Repositorio del que Copilot lee el código: el del pipeline, en el commit de la ejecución, u otro del proyecto, en su rama predeterminada">${options || '<option value="">Sin repositorio</option>'}</select></label>
    <label class="form-field">Carpeta local<input data-pipeline-local="${pipeline.id}" value="${escape(local)}" placeholder="${demo ? 'No disponible en el ejemplo' : 'vacío: se lee de Azure DevOps'}" ${demo || !chosen ? 'disabled' : ''} autocomplete="off" spellcheck="false" title="Con la carpeta de un clon, el código se lee con git (y se puede buscar en él); también lo usa la revisión de PRs"></label></div>`;
}

function copilotLine(ui, demo, state) {
  if (demo) return '';
  const status = ui.copilot;
  const text = !status ? 'GitHub Copilot' : status.isAuthenticated ? `GitHub Copilot · ${escape(status.login || 'cuenta de GitHub')}` : 'GitHub Copilot sin sesión';
  const choice = status?.isAuthenticated ? ` · ${aiChoice({ attrs: 'data-ai-choice="pipeline"', models: status.models, model: state.pipelineModel ?? '', effort: state.pipelineEffort ?? '', automatic: status.defaultModel, auto: status.defaultModel ? `Predeterminado (${status.defaultModel})` : 'Modelo predeterminado', name: 'de la revisión de pipelines', modelClass: 'pr-model' })}` : '';
  return ` · <span class="${status && !status.isAuthenticated ? 'warning-text' : 'text-muted'}">${text}</span>${choice} <button class="link-button" data-action="pr-copilot-status">Comprobar</button>`;
}

const matches = (pipeline, filter) => matchesQuery(filter, normalize(`${pipeline.name} ${folder(pipeline.path)} ${pipeline.repository?.name ?? ''}`));
// Hides the rows that do not match, without redrawing the list.
export function filterPipelines(ui, value) {
  ui.filter = value;
  for (const row of document.querySelectorAll('[data-pipeline-row]')) row.hidden = !matches(JSON.parse(row.dataset.pipelineRow), value);
}
function pipelineRow(state, pipeline, hidden) {
  const run = pipeline.latest, done = pipeline.lastCompleted, saved = analysesOf(state, pipeline.id)[0];
  const meta = run ? [`#${escape(run.number)}`, escape(branch(run.sourceBranch)), when(run.startTime ?? run.queueTime), run.status === 'completed' ? duration(elapsed(run.startTime, run.finishTime)) : ''].filter(Boolean).join(' · ') : '';
  const previous = done && run && done.id !== run.id ? ` <span class="text-muted">· anterior</span> ${statusPill(done)}` : '';
  const search = escape(JSON.stringify({ name: pipeline.name, path: pipeline.path, repository: { name: pipeline.repository?.name ?? '' } }));
  return `<li data-pipeline-row="${search}" ${hidden ? 'hidden' : ''}><div><button class="link-button pipeline-name" data-action="pipeline-open" data-pipeline="${pipeline.id}">${escape(pipeline.name)}</button>${statusPill(run)}${previous}<small>${folder(pipeline.path) ? `${escape(folder(pipeline.path))} · ` : ''}${meta || 'Sin ejecuciones'}</small></div>
    <span class="pr-row-actions">${saved ? `<button class="button small" data-action="pipeline-open" data-pipeline="${pipeline.id}">Abrir</button>` : ''}<button class="button small primary" data-action="pipeline-review" data-pipeline="${pipeline.id}" ${done ? `title="${escape(`${reviewLabel(done)} · ejecución #${done.number}`)}"` : 'disabled title="Sin ejecuciones terminadas"'}>${saved ? 'Volver a revisar' : 'Revisar'}</button></span></li>`;
}
const recency = p => Date.parse(p.latest?.queueTime ?? p.latest?.startTime ?? '') || 0;
function listView(state, snapshot, ui) {
  const list = [...snapshot.pipelines].sort((a, b) => recency(b) - recency(a) || a.name.localeCompare(b.name));
  if (!list.length) return '<div class="empty-panel"><h2>Sin pipelines</h2></div>';
  return `<section class="pr-card"><input class="pipeline-filter" type="search" data-pipeline-filter value="${escape(ui.filter ?? '')}" placeholder="Buscar pipeline" aria-label="Buscar pipeline" autocomplete="off">
    <ul class="pr-list pipeline-list">${list.map(p => pipelineRow(state, p, !matches(p, ui.filter ?? ''))).join('')}</ul></section>`;
}

function findingView(finding, kind) {
  const where = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''}` : '';
  return `<article class="pr-finding priority-${escape(finding.priority)}">
    <header><span class="pipeline-finding-title"><span class="pill severity">${escape(PRIORITY_LABELS[finding.priority] ?? finding.priority)}</span><strong>${escape(finding.title)}</strong></span>${kind === 'optimization' && finding.saving ? `<span class="pill changed" title="Ahorro estimado por ejecución">${escape(finding.saving)}</span>` : ''}</header>
    ${where ? `<p class="pr-location"><code>${escape(where)}</code></p>` : ''}
    <div class="jira-md">${markdown(finding.body)}</div>
    ${finding.fix ? `<div class="pipeline-fix"><pre class="md-code"><code>${escape(finding.fix)}</code></pre><button class="button small" data-action="pipeline-copy" data-finding="${escape(finding.id)}">Copiar</button></div>` : ''}
  </article>`;
}
function analysisView(analysis, others) {
  const usage = [analysis.source?.repository && `código de ${escape(analysis.source.repository)}${analysis.source.kind === 'local' ? ` en ${escape(analysis.source.path)}` : analysis.source.kind === 'azure' ? ' en Azure DevOps' : ''}`, analysis.reads ? `${analysis.reads} ${analysis.reads === 1 ? 'lectura' : 'lecturas'}` : '', analysis.copilot?.model && `modelo ${escape(analysis.copilot.model)}${analysis.copilot.effort ? ` · esfuerzo ${escape(effortName(analysis.copilot.effort).toLowerCase())}` : ''}`, analysis.copilot?.inputTokens && `${analysis.copilot.inputTokens + (analysis.copilot.outputTokens ?? 0)} tokens`].filter(Boolean).join(' · ');
  return `<section class="pipeline-analysis">
    <p class="text-muted pipeline-analysis-meta"><span class="pill ${analysis.kind === 'failure' ? 'verdict-changes' : 'verdict-approve'}">${analysis.kind === 'failure' ? 'Por qué falló' : 'Cómo mejorarlo'}</span> ${link(analysis.mode === 'demo' ? null : analysis.run.url, `#${escape(analysis.run.number)}`)} · ${escape(RESULT_LABELS[analysis.run.result] ?? analysis.run.result ?? '')} · revisado ${when(analysis.createdAt)}${usage ? ` · ${usage}` : ''}</p>
    ${analysis.source?.note ? `<div class="notice warning">${escape(analysis.source.note)}</div>` : ''}
    <section class="pr-summary"><div class="jira-md">${markdown(analysis.summary)}</div>${analysis.cause ? `<h3>Causa <span class="pill">${escape(CATEGORY_LABELS[analysis.category] ?? analysis.category)}</span></h3><div class="jira-md">${markdown(analysis.cause)}</div>` : ''}</section>
    ${analysis.findings.length ? analysis.findings.map(f => findingView(f, analysis.kind)).join('') : '<p class="empty-result">Copilot no propone cambios.</p>'}
    <div class="pr-actions">${others.length ? `<label class="pipeline-history">Revisión<select data-pipeline-analysis aria-label="Revisión">${[analysis, ...others].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(a => `<option value="${escape(a.id)}" ${a.id === analysis.id ? 'selected' : ''}>${when(a.createdAt)} · #${escape(a.run.number)}</option>`).join('')}</select></label>` : ''}<button class="button danger" data-action="pipeline-analysis-delete" data-analysis="${escape(analysis.id)}">Descartar revisión</button></div>
  </section>`;
}
function detailView(state, snapshot, ui) {
  const pipeline = snapshot.pipelines.find(p => p.id === ui.pipelineId);
  if (!pipeline) return `<button class="link-button" data-action="pipeline-back">← Todos los pipelines</button><p class="empty-result">El pipeline ya no está en ${escape(snapshot.project)}.</p>`;
  const run = pipeline.latest, done = pipeline.lastCompleted, analyses = analysesOf(state, pipeline.id);
  const analysis = analyses.find(a => a.id === ui.analysisId) ?? analyses[0];
  const runLine = run ? `${statusPill(run)} ${link(run.url, `#${escape(run.number)}`)} · ${escape(branch(run.sourceBranch))} · ${when(run.startTime ?? run.queueTime)}${run.status === 'completed' ? ` · ${duration(elapsed(run.startTime, run.finishTime))}` : ''}${run.requestedFor ? ` · ${escape(run.requestedFor)}` : ''}` : 'Sin ejecuciones';
  return `<section class="pr-detail">
    <button class="link-button" data-action="pipeline-back">← Todos los pipelines</button>
    <header class="pr-detail-heading"><div>${folder(pipeline.path) ? `<p class="eyebrow">${escape(folder(pipeline.path))}</p>` : ''}<h2>${link(pipeline.url, escape(pipeline.name))}</h2><p class="text-muted">${runLine}</p></div>
      <button class="button primary" data-action="pipeline-review" data-pipeline="${pipeline.id}" ${done ? `title="${escape(`${reviewLabel(done)} · ejecución #${done.number}`)}"` : 'disabled title="Sin ejecuciones terminadas"'}>${analyses.length ? 'Volver a revisar' : 'Revisar'}</button></header>
    ${sourceView(state, snapshot, pipeline)}
    ${analysis ? analysisView(analysis, analyses.filter(a => a.id !== analysis.id)) : ''}
  </section>`;
}

export function pipelinesView(state, ui) {
  const demo = state.mode === 'demo', snapshot = ui.snapshot;
  const refresh = `<button class="button small" data-action="pipelines-refresh" ${snapshot ? `title="Consultado ${escape(when(snapshot.fetchedAt))}"` : ''}>Actualizar</button>`;
  const heading = `<header class="maintenance-heading"><div><p class="eyebrow">PIPELINES</p><h1>Pipelines</h1><p>${escape(demo ? 'Datos de ejemplo' : state.config?.project || '')}${copilotLine(ui, demo, state)}</p></div>${demo || state.config?.project ? refresh : ''}</header>`;
  if (!demo && !state.config?.project) return `<section class="maintenance-page">${heading}<div class="empty-panel"><h2>Sin proyecto conectado</h2><button class="button primary" data-action="connect">Conectar Azure DevOps</button></div></section>`;
  if (!snapshot) return `<section class="maintenance-page">${heading}</section>`;
  return `<section class="maintenance-page">${heading}${demo ? '' : loginView(ui)}${ui.pipelineId ? detailView(state, snapshot, ui) : listView(state, snapshot, ui)}</section>`;
}
