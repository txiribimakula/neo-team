// Pull request review: choose a pull request, let GitHub Copilot review its diff,
// adjust the comments and, only after confirming, publish them to Azure DevOps.
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = value => value ? new Date(value).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const branch = ref => String(ref ?? '').replace(/^refs\/heads\//, '');
export const SEVERITY_LABELS = { blocker: 'Bloqueante', major: 'Importante', minor: 'Menor', suggestion: 'Sugerencia' };
export const VERDICT_LABELS = { approve: 'Se puede aprobar', comment: 'Aprobable con comentarios', changes: 'Necesita cambios' };
export const location = finding => finding.file ? `${finding.file}${finding.line ? `:${finding.line}${finding.suggestion && finding.suggestion.endLine > finding.line ? `-${finding.suggestion.endLine}` : ''}` : ' · todo el archivo'}` : 'Comentario general';
export const pendingFindings = review => review.findings.filter(f => f.selected && !f.published);

function copilotLine(ui, demo, state) {
  if (demo) return '<span class="text-muted">La revisión de Copilot se simula y nada se publica en Azure DevOps.</span>';
  const status = ui.copilot;
  const text = !status ? 'GitHub Copilot' : status.isAuthenticated ? `GitHub Copilot · ${escape(status.login || 'cuenta de GitHub')}` : 'GitHub Copilot sin sesión';
  return `<span class="${status && !status.isAuthenticated ? 'warning-text' : 'text-muted'}">${text}</span>${status?.isAuthenticated ? modelSelect(status, state.copilotModel ?? '') : ''} <button class="link-button" data-action="pr-copilot-status">Comprobar</button>`;
}
// The model that reviews, among those the account may use (× is its cost multiplier).
function modelSelect(status, current) {
  const models = [...(current && !status.models?.some(m => m.id === current) ? [{ id: current, name: current }] : []), ...(status.models ?? [])];
  const label = model => `${model.name}${model.multiplier != null ? ` · ×${model.multiplier}` : ''}`;
  return ` · <select class="pr-model" data-copilot-model aria-label="Modelo de IA para la revisión" title="Modelo con el que Copilot hace la revisión"><option value="">${status.defaultModel ? `Predeterminado (${escape(status.defaultModel)})` : 'Modelo predeterminado'}</option>${models.map(m => `<option value="${escape(m.id)}" ${m.id === current ? 'selected' : ''}>${escape(label(m))}</option>`).join('')}</select>`;
}

// Copilot runs in the local server, not in the browser: it uses the GitHub session
// saved on this computer (Copilot CLI, GitHub CLI or COPILOT_GITHUB_TOKEN), never the
// browser's. The browser only authorizes the sign-in code, with the account open in it.
export const LOGIN_OPTIONS = [
  { command: 'npm install -g @github/copilot', title: 'Instala Copilot CLI si no lo tienes.' },
  { command: 'copilot', then: '/login', title: 'Copilot CLI guarda la sesión solo para Copilot y no cambia la cuenta de gh.' },
  { command: 'gh auth login --web', title: 'Alternativa: GitHub CLI. Cambia la cuenta activa de gh a la de la empresa. Copilot no acepta tokens clásicos (ghp_…).' },
];
function loginView(ui) {
  if (ui.copilot?.isAuthenticated !== false) return '';
  return `<section class="pr-card pr-login"><h2>Iniciar sesión en GitHub Copilot</h2><ul class="pr-login-options">${LOGIN_OPTIONS.map(o => `<li title="${escape(o.title)}"><code>${escape(o.command)}</code>${o.then ? ` → <code>${escape(o.then)}</code>` : ''}<button class="button small" data-action="pr-copy" data-copy="${escape(o.command)}">Copiar</button></li>`).join('')}</ul><p class="local-note">Abre en una ventana privada el enlace que muestra, entra con tu cuenta de la empresa (github.com/enterprises/…) y escribe el código.</p><button class="button primary" data-action="pr-copilot-status">Comprobar</button></section>`;
}

// The local clone of a repository: with it, pull requests are compared with git.
const localKey = (state, project, repository) => [state.config?.organization, project, repository].map(part => String(part ?? '').trim().toLowerCase()).join('/');
export const localFolder = (state, project, repository) => state.localRepositories?.[localKey(state, project, repository)] ?? '';
function localField(state, project, repository) {
  return `<label class="form-field pr-local">Carpeta local de ${escape(repository)}<input data-pr-local data-project="${escape(project)}" data-repository="${escape(repository)}" value="${escape(localFolder(state, project, repository))}" placeholder="/ruta/al/clon · vacío: se lee de Azure DevOps" autocomplete="off" spellcheck="false" title="Con la carpeta de un clon del repositorio, el diff se calcula con git entre las ramas del pull request"></label>`;
}

function pickerView(state, ui) {
  const repositories = ui.repositories;
  const repositorySelect = repositories ? `<label class="form-field">Repositorio<select id="pr-repository" aria-label="Repositorio"><option value="">Elige un repositorio…</option>${repositories.map(r => `<option value="${escape(r.name)}" ${r.name === ui.repository ? 'selected' : ''}>${escape(r.name)}</option>`).join('')}</select></label>` : `<button class="button" data-action="pr-load-repositories">Ver repositorios de ${escape(state.mode === 'demo' ? 'Neo Platform' : state.config?.project)}</button>`;
  const list = ui.pullRequests ? (ui.pullRequests.length ? `<ul class="pr-list">${ui.pullRequests.map(pr => `<li><div><strong>!${pr.pullRequestId} · ${escape(pr.title)}</strong>${pr.isDraft ? ' <span class="pill">Borrador</span>' : ''}<small>${escape(pr.createdBy?.displayName ?? '')} · ${escape(branch(pr.sourceRefName))} → ${escape(branch(pr.targetRefName))}</small></div><button class="button small primary" data-action="pr-review" data-repository="${escape(ui.repository)}" data-pull-request="${pr.pullRequestId}">Revisar</button></li>`).join('')}</ul>` : '<p class="empty-result">No hay pull requests activos en este repositorio.</p>') : '';
  return `<section class="pr-card"><h2>Nueva revisión</h2>
    <form id="pr-url-form" class="pr-url"><label class="form-field">URL del pull request<input name="url" type="url" required placeholder="https://dev.azure.com/organización/proyecto/_git/repositorio/pullrequest/123" autocomplete="off"></label><button class="button primary" type="submit">Revisar con Copilot</button></form>
    <p class="pr-or">o elige uno de la lista</p>${repositorySelect}${ui.repository && state.mode !== 'demo' ? localField(state, state.config?.project, ui.repository) : ''}${ui.repository ? '<button class="button small" data-action="pr-refresh-list">Actualizar pull requests</button>' : ''}${list}
    <p class="local-note">${state.mode === 'demo' ? 'Estás usando datos de ejemplo: no se envía código a Copilot ni se publica en Azure DevOps.' : 'El diff del pull request se envía a GitHub Copilot con tu cuenta de GitHub. Copilot no tiene herramientas ni acceso a archivos. Nada se publica en Azure DevOps hasta que lo confirmes.'}</p></section>`;
}

function historyView(reviews) {
  if (!reviews.length) return '';
  return `<section class="pr-card"><h2>Revisiones guardadas</h2><ul class="pr-list">${reviews.map(r => {
    const published = r.findings.filter(f => f.published).length;
    return `<li><div><strong>${escape(r.repository.name)} !${r.pullRequest.id} · ${escape(r.pullRequest.title)}</strong><small>${when(r.createdAt)} · ${r.findings.length} comentarios${published ? ` · ${published} publicados` : ''}</small></div><span class="pill verdict-${escape(r.verdict)}">${escape(VERDICT_LABELS[r.verdict])}</span><button class="button small" data-action="pr-open" data-review="${escape(r.id)}">Abrir</button></li>`;
  }).join('')}</ul></section>`;
}

function findingView(review, finding) {
  const done = !!finding.published;
  return `<article class="pr-finding severity-${escape(finding.severity)} ${done ? 'published' : ''}">
    <header><label class="pr-select"><input type="checkbox" data-pr-select="${escape(finding.id)}" data-focus="pr-select:${escape(finding.id)}" ${finding.selected || done ? 'checked' : ''} ${done ? 'disabled' : ''} aria-label="Publicar «${escape(finding.title)}»"><span class="pill severity">${escape(SEVERITY_LABELS[finding.severity])}</span><strong>${escape(finding.title)}</strong></label>${done ? `<span class="pill changed">${review.mode === 'demo' ? 'Publicado (simulado)' : 'Publicado en Azure'} ✓</span>` : ''}</header>
    <p class="pr-location"><code>${escape(location(finding))}</code></p>
    <textarea data-pr-body="${escape(finding.id)}" data-focus="pr-body:${escape(finding.id)}" rows="${Math.min(12, Math.max(3, finding.body.split('\n').length + 1))}" maxlength="4000" aria-label="Texto del comentario" ${done ? 'disabled' : ''}>${escape(finding.body)}</textarea>
    ${suggestionView(finding, done)}
  </article>`;
}
// The suggested change as Azure DevOps shows it: the commented lines and what replaces them.
function suggestionView(finding, done) {
  const s = finding.suggestion;
  if (!s) return '';
  const lines = s.code.split('\n').length;
  return `<div class="pr-suggestion"><pre class="pr-suggestion-old" aria-label="Líneas actuales">${s.original.map((line, i) => `<span>${String(s.startLine + i).padStart(4)}  ${escape(line)}</span>`).join('')}</pre><textarea class="pr-suggestion-new" data-pr-suggestion="${escape(finding.id)}" data-focus="pr-suggestion:${escape(finding.id)}" rows="${Math.min(14, lines + 1)}" maxlength="4000" spellcheck="false" aria-label="Cambio propuesto" title="Se publica como cambio sugerido de Azure DevOps. Vacío: sin cambio propuesto" ${done ? 'disabled' : ''}>${escape(s.code)}</textarea></div>`;
}

function detailView(review, ui, state) {
  const pending = pendingFindings(review), demo = review.mode === 'demo';
  const publicationCount = pending.length + Number(!review.summaryPublished && !!ui.includeSummary);
  const canPublish = publicationCount > 0 && review.pullRequest.status === 'active';
  const notes = [
    review.notes.truncated && `${review.notes.omittedFiles} archivos no se incluyeron por tamaño: revísalos a mano.`,
    review.notes.binaryFiles && `${review.notes.binaryFiles} archivos binarios no revisados.`,
    review.notes.unreadableFiles && `${review.notes.unreadableFiles} archivos no se pudieron leer en Azure DevOps y no se han revisado.`,
    review.notes.tooLargeFiles && `${review.notes.tooLargeFiles} archivos demasiado grandes no revisados.`,
    review.pullRequest.status !== 'active' && 'El pull request ya no está activo: no se podrán publicar comentarios.',
  ].filter(Boolean);
  const usage = [review.diffSource?.kind === 'local' && `diff local en ${escape(review.diffSource.path)}`, review.copilot?.login && `cuenta ${escape(review.copilot.login)}`, review.copilot?.model && `modelo ${escape(review.copilot.model)}`, review.copilot?.inputTokens && `${review.copilot.inputTokens + (review.copilot.outputTokens ?? 0)} tokens`].filter(Boolean).join(' · ');
  return `<section class="pr-detail">
    <button class="link-button" data-action="pr-back">← Todas las revisiones</button>
    <header class="pr-detail-heading"><div><p class="eyebrow">${escape(review.repository.name)} · !${review.pullRequest.id}</p><h2>${demo ? escape(review.pullRequest.title) : `<a href="${escape(review.pullRequest.url)}" target="_blank" rel="noopener noreferrer">${escape(review.pullRequest.title)} ↗</a>`}</h2>
      <p class="text-muted">${escape(review.pullRequest.author)} · ${escape(branch(review.pullRequest.sourceRefName))} → ${escape(branch(review.pullRequest.targetRefName))} · revisado ${when(review.createdAt)}${usage ? ` · ${usage}` : ''}</p></div>
      <span class="pill verdict-${escape(review.verdict)}">${escape(VERDICT_LABELS[review.verdict])}</span></header>
    ${notes.map(n => `<div class="notice warning">${escape(n)}</div>`).join('')}
    <section class="pr-summary"><h3>Resumen</h3><p>${escape(review.summary)}</p><label class="pr-select"><input type="checkbox" id="pr-include-summary" ${review.summaryPublished ? 'checked disabled' : ui.includeSummary ? 'checked' : ''}>${review.summaryPublished ? `Resumen publicado ${review.mode === 'demo' ? '(simulado)' : 'en Azure'} ✓` : 'Publicar también el resumen como comentario general'}</label></section>
    <h3 class="review-section">Comentarios propuestos · ${review.findings.length}</h3><p class="local-note" role="status">${publicationCount ? `${publicationCount} comentario${publicationCount === 1 ? '' : 's'} seleccionado${publicationCount === 1 ? '' : 's'} para publicar, incluido el resumen si está marcado.` : 'Marca los comentarios o el resumen que quieras publicar.'}</p>
    ${review.findings.length ? review.findings.map(f => findingView(review, f)).join('') : '<p class="empty-result">Copilot no ha encontrado problemas en este pull request.</p>'}
    <p class="local-note">Revisa y ajusta el texto: los cambios se guardan en local. Marca los comentarios que quieras publicar; los que tienen línea se anclan a esa línea del pull request.</p>
    ${demo ? '' : localField(state, review.project, review.repository.name)}
    <div class="pr-actions"><button class="button danger" data-action="pr-delete" data-review="${escape(review.id)}">Descartar revisión</button><button class="button" data-action="pr-review" data-url="${escape(review.pullRequest.url)}">Volver a revisar</button><button class="button primary" data-action="pr-publish" data-review="${escape(review.id)}" ${canPublish ? '' : 'disabled'}>${demo ? 'Simular publicación' : 'Publicar en Azure DevOps'}${publicationCount ? ` (${publicationCount})` : ''}…</button></div>
  </section>`;
}

export function reviewsView(state, ui) {
  const demo = state.mode === 'demo', reviews = state.prReviews ?? [];
  const review = reviews.find(r => r.id === ui.reviewId);
  const heading = `<header class="maintenance-heading"><div><p class="eyebrow">REVISIÓN DE PULL REQUESTS</p><h1>Revisión de PRs</h1><p>${escape(demo ? 'Datos de ejemplo' : state.config?.project || 'Conecta un proyecto para revisar sus pull requests.')} · ${copilotLine(ui, demo, state)}</p></div></header>`;
  if (!demo && !state.config?.project) return `<section class="maintenance-page">${heading}${loginView(ui)}<div class="empty-panel"><h2>Sin proyecto conectado</h2><p>Conecta Azure DevOps para leer los pull requests de sus repositorios.</p><button class="button primary" data-action="connect">Conectar Azure DevOps</button></div></section>`;
  return `<section class="maintenance-page">${heading}${review ? detailView(review, ui, state) : (demo ? '' : loginView(ui)) + pickerView(state, ui) + historyView(reviews)}</section>`;
}

// What will be written, shown before anything is sent to Azure DevOps.
export function publishConfirmation(review, includeSummary) {
  const items = [...(includeSummary && !review.summaryPublished ? [{ where: 'Comentario general', title: 'Resumen de la revisión' }] : []), ...pendingFindings(review).map(f => ({ where: location(f), title: `${SEVERITY_LABELS[f.severity]}: ${f.title}${f.suggestion ? ' · con cambio propuesto' : ''}` }))];
  return { count: items.length, html: `<p>Se crearán <strong>${items.length} hilos nuevos</strong> en el pull request !${review.pullRequest.id} de «${escape(review.repository.name)}». No se modifican, resuelven ni borran comentarios existentes y no se vota el pull request.</p><ul class="pr-confirm-list">${items.map(i => `<li><code>${escape(i.where)}</code> ${escape(i.title)}</li>`).join('')}</ul><div class="notice">Antes de publicar se comprueba que el pull request no ha cambiado desde la revisión. Los comentarios se publican en inglés.</div>` };
}
