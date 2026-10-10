// Jira tickets collected to local folders, read only: the filter is queried and
// every ticket is saved as Markdown (description and comments) with its
// attachments next to it, under the same names the texts use to refer to them.
import { execFile } from 'node:child_process';
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const LIMITS = { tickets: 200, attachmentBytes: 300 * 1024 * 1024, frames: 40, text: 2000 };
export const VIDEO = /\.(mp4|mov|webm|avi|mkv|wmv|m4v)$/i;
export const IMAGE = /\.(png|jpe?g|gif|bmp|webp)$/i;

// The filter can be its number, a Jira URL with ?filter= or ?jql=, or JQL itself.
// Jira's system filters have negative ids and are not saved filters, so «filter = -1»
// does not work: they are replaced by the query each one stands for.
export const SYSTEM_FILTERS = {
  '-1': 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC',
  '-2': 'reporter = currentUser() ORDER BY created DESC',
  '-3': 'issuekey IN issueHistory() ORDER BY lastViewed DESC',
  '-4': 'created IS NOT EMPTY ORDER BY created DESC',
  '-5': 'resolution = Unresolved ORDER BY priority DESC, updated DESC',
  '-6': 'created >= -1w ORDER BY created DESC',
  '-7': 'resolutiondate >= -1w ORDER BY updated DESC',
  '-8': 'updated >= -1w ORDER BY updated DESC',
  '-9': 'statusCategory = Done ORDER BY updated DESC',
};
const byFilterId = id => {
  if (/^-\d+$/.test(id)) {
    if (!SYSTEM_FILTERS[id]) throw fail(`Jira no tiene el filtro del sistema ${id}. Usa un filtro guardado o una consulta JQL.`);
    return SYSTEM_FILTERS[id];
  }
  return `filter = ${id}`;
};
// The filter can be its number, a Jira URL with ?filter= or ?jql=, or JQL itself.
// A URL with both shows the filter changed by hand: its JQL is what is seen.
export function jqlFrom(value) {
  const text = String(value ?? '').trim();
  if (!text) throw fail('Indica el filtro de Jira: su número, su URL o una consulta JQL.');
  if (/^-?\d+$/.test(text)) return byFilterId(text);
  if (/^https?:\/\//i.test(text)) {
    let url;
    try { url = new URL(text); } catch { throw fail('La URL del filtro no es válida.'); }
    const jql = url.searchParams.get('jql')?.trim();
    if (jql) return jql;
    const filter = url.searchParams.get('filter')?.trim() ?? url.pathname.match(/\/filters?\/(-?\d+)/)?.[1];
    if (filter && /^-?\d+$/.test(filter)) return byFilterId(filter);
    throw fail('La URL no contiene un filtro (?filter=) ni una consulta (?jql=). Copia la dirección de la búsqueda o del filtro en Jira.');
  }
  return text;
}

// Each error names its field, so the form can point to it and keep the rest.
const invalid = (field, message) => Object.assign(fail(message), { field });
export function jiraSettingsFrom(input, previous = {}) {
  const value = (name, max = 500) => {
    const text = String(input?.[name] ?? '').trim();
    if (text.length > max) throw invalid(name, `El campo «${name}» admite hasta ${max} caracteres.`);
    return text;
  };
  let url = value('url').replace(/\/+$/, '');
  if (url && !/^https:\/\//i.test(url)) url = `https://${url}`;
  try { if (url) url = new URL(url).origin + new URL(url).pathname.replace(/\/+$/, ''); } catch { throw invalid('url', 'La URL de Jira no es válida.'); }
  if (!url) throw invalid('url', 'Indica la URL de Jira (https://empresa.atlassian.net).');
  const deployment = input?.deployment === 'datacenter' ? 'datacenter' : 'cloud';
  const email = value('email', 200);
  if (deployment === 'cloud' && !/^[^@\s]+@[^@\s]+$/.test(email)) throw invalid('email', 'Indica el correo de tu cuenta de Jira Cloud: el token se usa junto con él.');
  const filter = value('filter', 2000);
  try { jqlFrom(filter); } catch (error) { throw Object.assign(error, { field: 'filter' }); }
  const maxIterations = Number(input?.maxIterations ?? 3);
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 10) throw invalid('maxIterations', 'Las iteraciones deben estar entre 1 y 10.');
  return {
    url, deployment, email, filter, maxIterations,
    repository: value('repository', 1000), baseBranch: value('baseBranch', 200), buildCommand: value('buildCommand', 2000),
    launchCommand: value('launchCommand', 2000), ticketsDir: value('ticketsDir', 1000), models: previous.models ?? {},
  };
}

// --- Jira wiki markup (REST API v2, Cloud and Data Center) to Markdown --------

// Names as they are saved on disk: no folders, nothing Windows rejects.
export function safeName(name) {
  const clean = basename(String(name ?? '').replace(/\\/g, '/')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
  return (clean || 'adjunto').slice(0, 150);
}

// Every attachment keeps its Jira name, which is how texts refer to it. When two
// share a name, the newest keeps it (Jira shows that one) and older ones get their id.
export function attachmentNames(attachments = []) {
  const byName = new Map(), names = new Map();
  for (const a of [...attachments].sort((x, y) => String(y.created ?? '').localeCompare(String(x.created ?? '')))) {
    const name = safeName(a.filename);
    const lower = name.toLowerCase();
    if (!byName.has(lower)) { byName.set(lower, a.id); names.set(String(a.id), name); continue; }
    const ext = extname(name);
    names.set(String(a.id), `${name.slice(0, name.length - ext.length)}-${a.id}${ext}`);
  }
  return names;
}

export function wikiToMarkdown(text, attachments = new Map(), folder = 'adjuntos') {
  const files = new Map([...attachments.values()].map(name => [name.toLowerCase(), name]));
  const local = name => {
    const found = files.get(safeName(name).toLowerCase());
    return found ? `${folder}/${encodeURI(found)}` : null;
  };
  const blocks = [];
  const keep = value => `\u0000${blocks.push(value) - 1}\u0000`;
  let out = String(text ?? '').replace(/\r\n?/g, '\n');
  out = out.replace(/\{code(?::([^}]*))?\}([\s\S]*?)\{code\}/g, (_, options = '', code) => keep(`\n\`\`\`${(options.split('|').find(o => !o.includes('=')) ?? '').trim()}\n${code.replace(/^\n|\n$/g, '')}\n\`\`\`\n`));
  out = out.replace(/\{noformat(?::[^}]*)?\}([\s\S]*?)\{noformat\}/g, (_, code) => keep(`\n\`\`\`\n${code.replace(/^\n|\n$/g, '')}\n\`\`\`\n`));
  out = out.replace(/\{quote\}([\s\S]*?)\{quote\}/g, (_, quote) => quote.trim().split('\n').map(line => `> ${line}`).join('\n'));
  out = out.replace(/\{panel(?::[^}]*)?\}([\s\S]*?)\{panel\}/g, '$1');
  out = out.replace(/\{color(?::[^}]*)?\}([\s\S]*?)\{color\}/g, '$1');
  out = out.replace(/\{\{([^}]+?)\}\}/g, (_, code) => keep(`\`${code}\``));
  // Attachments: !image.png|thumbnail! and [^file.mp4] point to the local copy.
  out = out.replace(/!([^!\n|]+?)(?:\|[^!\n]*)?!/g, (all, name) => {
    if (/^https?:\/\//i.test(name)) return keep(`![](${name})`);
    const path = local(name);
    return path ? keep(`![${safeName(name)}](${path})`) : all;
  });
  out = out.replace(/\[\^([^\]\n]+)\]/g, (all, name) => { const path = local(name); return path ? keep(`[${safeName(name)}](${path})`) : all; });
  out = out.replace(/\[~(?:accountid:)?([^\]\n]+)\]/g, (_, user) => `@${user}`);
  out = out.replace(/\[([^\]|\n]+)\|([^\]\n]+)\]/g, (_, label, href) => keep(`[${label.trim()}](${href.trim()})`));
  out = out.replace(/\[(https?:\/\/[^\]\s]+)\]/g, (_, href) => keep(`<${href}>`));
  const lines = out.split('\n').map(line => {
    let match = line.match(/^h([1-6])\.\s+(.*)$/);
    if (match) return `${'#'.repeat(Number(match[1]))} ${match[2]}`;
    if ((match = line.match(/^bq\.\s+(.*)$/))) return `> ${match[1]}`;
    if ((match = line.match(/^([*#]+|-)\s+(.*)$/))) {
      const depth = match[1].length - 1, ordered = match[1].endsWith('#');
      return `${'  '.repeat(depth)}${ordered ? '1.' : '-'} ${match[2]}`;
    }
    if (/^\|\|.*\|\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\|\||\|\|$/g, '').split('||');
      return `| ${cells.join(' | ')} |\n${keep(`|${cells.map(() => ' --- ').join('|')}|`)}`;
    }
    if (/^\|.*\|\s*$/.test(line)) return line.trim();
    if (/^----\s*$/.test(line)) return keep('---');
    return line;
  });
  out = lines.join('\n')
    .replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*(?=[\s).,:;!?]|$)/gm, '$1**$2**')
    .replace(/(^|[\s(])\+(\S(?:[^+\n]*\S)?)\+(?=[\s).,:;!?]|$)/gm, '$1<ins>$2</ins>')
    .replace(/(^|[\s(])-(\S(?:[^-\n]*\S)?)-(?=[\s).,:;!?]|$)/gm, '$1~~$2~~');
  return out.replace(/\u0000(\d+)\u0000/g, (_, index) => blocks[Number(index)]).replace(/\n{3,}/g, '\n\n').trim();
}

// --- Jira REST client --------------------------------------------------------

export const TOKEN_HELP = 'Jira necesita un token: en Jira Cloud, un API token de id.atlassian.com/manage-profile/security/api-tokens con el correo de la cuenta; en Data Center, un token de acceso personal (Perfil → Tokens de acceso personal). Escríbelo en la configuración o defínelo en NEO_TEAM_JIRA_TOKEN antes de arrancar Neo Team.';
export class JiraClient {
  constructor(settings, token, { fetch: request = globalThis.fetch, timeoutMs = 60000 } = {}) {
    if (!token) throw Object.assign(fail(TOKEN_HELP, 401), { reason: 'jira-token' });
    this.settings = settings; this.request = request; this.timeoutMs = timeoutMs;
    this.authorization = settings.deployment === 'cloud' ? `Basic ${Buffer.from(`${settings.email}:${token}`).toString('base64')}` : `Bearer ${token}`;
  }
  async call(path, { query = {}, raw = false, url = null, method = 'GET', body = undefined } = {}) {
    const target = new URL(url ?? `${this.settings.url}${path}`);
    for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== null) target.searchParams.set(name, String(value));
    if (new URL(this.settings.url).origin !== target.origin) throw fail('El adjunto apunta fuera del servidor de Jira configurado.');
    const form = body instanceof FormData;
    const response = await this.request(target, { method, headers: { Authorization: this.authorization, Accept: raw ? '*/*' : 'application/json', 'X-Atlassian-Token': 'no-check', ...(body && !form ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: form ? body : JSON.stringify(body) } : {}), redirect: 'follow', signal: AbortSignal.timeout(raw || form ? 30 * 60000 : this.timeoutMs) });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      let message = detail;
      try { const data = JSON.parse(detail); message = [...(data.errorMessages ?? []), ...Object.values(data.errors ?? {})].join(' ') || data.message || detail; } catch { /* plain text */ }
      if (response.status === 401) throw Object.assign(fail(`Jira rechazó el acceso (401). Comprueba el correo y el token. ${TOKEN_HELP}`, 401), { reason: 'jira-token' });
      throw fail(`Jira respondió ${response.status} en ${target.pathname}: ${String(message).replace(/\s+/g, ' ').slice(0, 300)}`, response.status === 404 ? 404 : 502);
    }
    return raw ? response : response.status === 204 ? null : response.json();
  }
  // Cloud pages with nextPageToken (/search/jql); Data Center with startAt (/search).
  async search(jql, fields, onProgress = () => {}) {
    const issues = [];
    if (this.settings.deployment === 'cloud') {
      let nextPageToken;
      do {
        const page = await this.call('/rest/api/2/search/jql', { query: { jql, fields: fields.join(','), maxResults: 100, nextPageToken } });
        issues.push(...(page.issues ?? []));
        onProgress(issues.length);
        nextPageToken = page.isLast === false || page.nextPageToken ? page.nextPageToken : undefined;
      } while (nextPageToken && issues.length < LIMITS.tickets);
    } else {
      let total = Infinity;
      while (issues.length < Math.min(total, LIMITS.tickets)) {
        const page = await this.call('/rest/api/2/search', { query: { jql, fields: fields.join(','), maxResults: 100, startAt: issues.length } });
        total = page.total ?? 0;
        issues.push(...(page.issues ?? []));
        onProgress(issues.length);
        if (!page.issues?.length) break;
      }
    }
    return { issues: issues.slice(0, LIMITS.tickets), limited: issues.length > LIMITS.tickets };
  }
  issue(key) { return this.call(`/rest/api/2/issue/${encodeURIComponent(key)}`, { query: { fields: 'summary,description,environment,status,priority,issuetype,reporter,assignee,created,updated,labels,components,versions,fixVersions,attachment' } }); }
  async comments(key) {
    const comments = [];
    for (let startAt = 0; ; startAt += 100) {
      const page = await this.call(`/rest/api/2/issue/${encodeURIComponent(key)}/comment`, { query: { startAt, maxResults: 100, orderBy: 'created' } });
      comments.push(...(page.comments ?? []));
      if (!page.comments?.length || comments.length >= (page.total ?? 0)) return comments;
    }
  }
  download(url) { return this.call('', { url, raw: true }); }
  // The only writes, each one decided by the person: a comment with the progress of
  // the agents and the state of a ticket, as an attachment, for another computer
  // (replacing the previous one this computer uploaded).
  addComment(key, body) { return this.call(`/rest/api/2/issue/${encodeURIComponent(key)}/comment`, { method: 'POST', body: { body } }); }
  async attach(key, name, data) {
    const form = new FormData();
    form.append('file', new Blob([data], { type: 'application/zip' }), name);
    const [attachment] = await this.call(`/rest/api/2/issue/${encodeURIComponent(key)}/attachments`, { method: 'POST', body: form });
    return attachment;
  }
  deleteAttachment(id) { return this.call(`/rest/api/2/attachment/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
}

// --- Files on disk -----------------------------------------------------------

export async function writeAtomic(file, content) {
  const temp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(content, 'utf8'); await handle.close(); handle = null;
    await rename(temp, file);
  } finally { await handle?.close(); await unlink(temp).catch(() => {}); }
}

const person = user => user?.displayName ?? user?.name ?? 'Desconocido';
// A Jira account as the board keeps it: its id (Cloud accountId, Data Center key or
// name) to compare it with the connected account, and its name to show it.
export const accountOf = user => user ? { id: String(user.accountId ?? user.key ?? user.name ?? user.emailAddress ?? user.displayName), name: user.displayName ?? user.name ?? '' } : null;
const day = value => value ? new Date(value).toISOString().replace('T', ' ').slice(0, 16) : '';
export const ticketUrl = (settings, key) => `${settings.url}/browse/${encodeURIComponent(key)}`;

export function descriptionMarkdown(settings, issue, names) {
  const f = issue.fields ?? {};
  const facts = [['Tipo', f.issuetype?.name], ['Estado', f.status?.name], ['Prioridad', f.priority?.name], ['Informador', f.reporter && person(f.reporter)], ['Asignado', f.assignee && person(f.assignee)], ['Creado', day(f.created)], ['Actualizado', day(f.updated)], ['Etiquetas', f.labels?.join(', ')], ['Componentes', f.components?.map(c => c.name).join(', ')], ['Versiones afectadas', f.versions?.map(v => v.name).join(', ')], ['Versión de corrección', f.fixVersions?.map(v => v.name).join(', ')]].filter(([, value]) => value);
  const attachments = (f.attachment ?? []).map(a => `- [${names.get(String(a.id))}](adjuntos/${encodeURI(names.get(String(a.id)))}) · ${person(a.author)} · ${day(a.created)}`);
  return `# ${issue.key} · ${f.summary ?? ''}\n\n${ticketUrl(settings, issue.key)}\n\n${facts.map(([name, value]) => `- **${name}:** ${value}`).join('\n')}\n\n## Descripción\n\n${wikiToMarkdown(f.description, names) || '(sin descripción)'}\n${f.environment ? `\n## Entorno\n\n${wikiToMarkdown(f.environment, names)}\n` : ''}${attachments.length ? `\n## Adjuntos\n\n${attachments.join('\n')}\n` : ''}`;
}
export function commentsMarkdown(issue, comments, names) {
  return `# Comentarios de ${issue.key}\n\n${comments.length ? comments.map(c => `## ${person(c.author)} · ${day(c.created)}${c.updated && c.updated !== c.created ? ` (editado ${day(c.updated)})` : ''}\n\n${wikiToMarkdown(c.body, names)}`).join('\n\n') : '(sin comentarios)'}\n`;
}

const which = command => new Promise(resolve => execFile(process.platform === 'win32' ? 'where' : 'which', [command], { timeout: 5000 }, error => resolve(!error)));
export const hasFfmpeg = () => which('ffmpeg');

// A video cannot be read by the agents: some frames are kept as images next to it.
export function extractFrames(video, folder, { run = execFile } = {}) {
  return new Promise(resolve => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vf', "fps=1/2,scale='min(1280,iw)':-2", '-frames:v', String(LIMITS.frames), join(folder, '%03d.png')], { timeout: 5 * 60000 }, error => resolve(!error)));
}

async function saveAttachment(client, attachment, file) {
  const existing = await stat(file).catch(() => null);
  if (existing?.size === attachment.size) return 'kept';
  if (attachment.size > LIMITS.attachmentBytes) return 'tooLarge';
  const response = await client.download(attachment.content);
  const temp = `${file}.${randomUUID()}.part`;
  try { await pipeline(Readable.fromWeb(response.body), createWriteStream(temp, { mode: 0o600 })); await rename(temp, file); }
  finally { await unlink(temp).catch(() => {}); }
  return 'downloaded';
}

// The state of a ticket shared from Neo Team on another computer travels as this
// attachment. It is not downloaded with the others: it is brought when the person asks.
export const SHARED = /^neo-team-estado-.*\.zip$/i;
export const sharedName = key => `neo-team-estado-${key}.zip`;
export const sharedOf = attachments => {
  const latest = attachments.filter(a => SHARED.test(a.filename ?? '')).sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')))[0];
  return latest ? { id: String(latest.id), created: latest.created ?? null, author: latest.author ? person(latest.author) : '', size: latest.size ?? null, content: latest.content } : null;
};

// Downloads one ticket: descripcion.md, comentarios.md and adjuntos/ with every
// attachment (plus frames of each video when ffmpeg is installed).
export async function collectTicket({ client, settings, key, folder, ffmpeg = false, onProgress = () => {} }) {
  const issue = await client.issue(key);
  const all = issue.fields?.attachment ?? [], attachments = all.filter(a => !SHARED.test(a.filename ?? ''));
  issue.fields = { ...issue.fields, attachment: attachments };
  const names = attachmentNames(attachments);
  const files = join(folder, 'adjuntos');
  await mkdir(files, { recursive: true, mode: 0o700 });
  const skipped = [];
  for (const [index, attachment] of attachments.entries()) {
    const name = names.get(String(attachment.id));
    onProgress(`${key} · adjunto ${index + 1} de ${attachments.length}: ${name}`);
    try {
      const result = await saveAttachment(client, attachment, join(files, name));
      if (result === 'tooLarge') skipped.push(`${name} (${Math.round(attachment.size / 1e6)} MB, más del límite)`);
      if (result === 'downloaded' && ffmpeg && VIDEO.test(name)) {
        const frames = join(files, `${name}.fotogramas`);
        await rm(frames, { recursive: true, force: true }); await mkdir(frames, { recursive: true });
        onProgress(`${key} · extrayendo fotogramas de ${name}`);
        if (!(await extractFrames(join(files, name), frames))) await rm(frames, { recursive: true, force: true });
      }
    } catch (error) { skipped.push(`${name} (${error.message})`); }
  }
  onProgress(`${key} · comentarios`);
  const comments = await client.comments(key);
  await writeAtomic(join(folder, 'descripcion.md'), descriptionMarkdown(settings, issue, names) + (skipped.length ? `\n## Adjuntos no descargados\n\n${skipped.map(s => `- ${s}`).join('\n')}\n` : ''));
  await writeAtomic(join(folder, 'comentarios.md'), commentsMarkdown(issue, comments, names));
  // The same comments one by one, for the interface.
  await writeAtomic(join(folder, 'comentarios.json'), JSON.stringify(comments.map(c => ({ author: person(c.author), created: c.created ?? null, updated: c.updated && c.updated !== c.created ? c.updated : null, body: wikiToMarkdown(c.body, names) })), null, 2));
  const f = issue.fields ?? {};
  return { key: issue.key, summary: f.summary ?? '', type: f.issuetype?.name ?? '', jiraStatus: f.status?.name ?? '', priority: f.priority?.name ?? '', updated: f.updated ?? null, url: ticketUrl(settings, issue.key), attachments: attachments.length, comments: comments.length, skipped, shared: sharedOf(all) };
}

// Files of a ticket, for the agents and the interface.
export async function listFiles(folder, depth = 2) {
  const out = [];
  const walk = async (dir, prefix, level) => {
    for (const entry of (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === 'codigo') continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (level < depth) await walk(join(dir, entry.name), path, level + 1); else out.push(`${path}/`); }
      else out.push(path);
    }
  };
  await walk(folder, '', 0);
  return out;
}
export const readText = (file, max = Infinity) => readFile(file, 'utf8').then(text => text.length > max ? `${text.slice(0, max)}\n…` : text, () => null);
export { writeFile };
