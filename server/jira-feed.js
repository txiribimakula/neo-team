// What happens on the board, curated for the person: one line per thing that
// matters (a step that starts or ends, each tool the AI uses with its result, what
// the AI says, what the person does, what reaches Jira), with the long part folded.
// The complete logs stay in each ticket's folder; this is the summary, kept on disk.
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeAtomic } from './jira.js';

export const FAMILIES = ['person', 'ai', 'tool', 'step', 'jira', 'warning', 'error'];
const LIMIT = 300, SHOWN = 150, DETAIL = 4000, TITLE = 160;

const clean = text => String(text ?? '').trim();
// The first line as the title; the rest, or all of it when long, folded.
export function split(text) {
  const value = clean(text), [first = '', ...rest] = value.split('\n');
  const title = first.length > TITLE ? `${first.slice(0, TITLE - 1)}…` : first;
  const detail = rest.length || first.length > TITLE ? value : '';
  return { title, detail: detail.length > DETAIL ? `${detail.slice(0, DETAIL)}\n…` : detail };
}

// An entry of an agent's activity, as it is shown: null when it is not worth a line.
// `kind` says what it is; `toolId`/`phase` tie the start and the end of a tool.
export function curate(entry) {
  const message = clean(entry.message);
  switch (entry.kind) {
    case 'note': return null;
    case 'person': return { family: 'person', ...split(message.replace(/^Tú:\s*/, '')) };
    case 'agent': return { family: 'ai', ...split(message) };
    case 'learn': return { family: 'ai', ...split(message) };
    case 'warning': return entry.toolId ? null : { family: 'warning', ...split(message) };
    case 'output': return { family: 'tool', output: true, title: 'Salida', detail: message };
    case 'tool': return entry.toolId ? null : { family: 'tool', ...split(message) };
    case 'result': return entry.toolId ? null : { family: 'step', ...split(message) };
    default: return message ? { family: 'ai', ...split(message) } : null;
  }
}

export class ActivityFeed {
  constructor(file) { this.file = file; this.items = []; this.tools = new Map(); this.seq = 0; this.ready = this.load(); }
  async load() {
    let saved = [];
    try { saved = JSON.parse(await readFile(this.file, 'utf8')); } catch { /* none yet */ }
    // A tool still running when Neo Team closed did not finish. What was added while
    // reading goes after it, renumbered.
    saved = saved.map(item => item.status === 'running' ? { ...item, status: 'stopped' } : item);
    let seq = saved.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0);
    const ids = new Map(this.items.map(item => [item.id, String(++seq)]));
    this.items = [...saved, ...this.items.map(item => ({ ...item, id: ids.get(item.id) }))].slice(-LIMIT);
    for (const [tool, id] of this.tools) this.tools.set(tool, ids.get(id) ?? id);
    this.seq = seq;
  }
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.saving = mkdir(dirname(this.file), { recursive: true }).then(() => writeAtomic(this.file, JSON.stringify(this.items))).catch(() => {}); }, 400);
    this.timer.unref?.();
  }
  add(event) {
    if (!event?.title && !event?.detail) return null;
    const item = { id: String(++this.seq), at: Date.now(), ...event };
    this.items = [...this.items, item].slice(-LIMIT);
    this.save();
    return item.id;
  }
  update(id, change) {
    this.items = this.items.map(item => item.id === id ? { ...item, ...change } : item);
    this.save();
  }
  // An agent's activity, in the context of a ticket and step (or of the assistant).
  activity(entry, context = {}) {
    if (entry.toolId && entry.phase === 'start') {
      const id = this.add({ ...context, family: 'tool', status: 'running', ...split(entry.title ?? entry.message) });
      if (id) this.tools.set(entry.toolId, id);
      return;
    }
    if (entry.toolId && entry.phase === 'end') {
      const id = this.tools.get(entry.toolId);
      this.tools.delete(entry.toolId);
      const detail = clean(entry.detail);
      const change = { status: entry.ok ? 'ok' : 'failed', meta: entry.seconds != null ? `${entry.seconds} s` : undefined, detail: detail.length > DETAIL ? `${detail.slice(0, DETAIL)}\n…` : detail };
      if (id) this.update(id, change); else this.add({ ...context, family: 'tool', ...split(entry.title), ...change });
      return;
    }
    const event = curate(entry);
    if (!event) return;
    // The output of a build goes on in one folded line.
    const last = this.items.at(-1);
    if (event.output && last?.output && last.key === context.key) {
      const detail = `${last.detail}\n${event.detail}`;
      return this.update(last.id, { detail: detail.length > DETAIL ? `…${detail.slice(-DETAIL)}` : detail, at: Date.now() });
    }
    this.add({ ...context, ...event });
  }
  // Nueva conversación empties the panel: only what is still at work stays.
  async clear() {
    await this.ready;
    this.items = this.items.filter(item => item.status === 'running');
    this.save();
  }
  recent() { return this.items.slice(-SHOWN); }
}
