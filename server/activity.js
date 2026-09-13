// Activity shared by the MCP process and the local server: short messages about
// what a query is doing or waiting for. They never carry tokens or credentials.
export const ACTIVITY_PREFIX = 'NEO_ACTIVITY ';
export const seconds = ms => `${(Math.max(0, ms) / 1000).toFixed(1).replace('.', ',')} s`;
export const activityLine = (kind, message) => `${ACTIVITY_PREFIX}${JSON.stringify({ kind, message })}\n`;

// Reads prefixed lines from the MCP stderr. Everything else is drained unread.
export function activityReader(onEntry) {
  let buffer = '';
  return chunk => {
    buffer += chunk.toString();
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.startsWith(ACTIVITY_PREFIX)) continue;
      try {
        const entry = JSON.parse(line.slice(ACTIVITY_PREFIX.length));
        if (typeof entry?.message === 'string') onEntry({ kind: String(entry.kind || 'info'), message: entry.message.slice(0, 300) });
      } catch { /* A malformed line is not activity. */ }
    }
    if (buffer.length > 100000) buffer = '';
  };
}

const toolNames = {
  work: 'trabajo del equipo', wit_backlog: 'backlog', wit_work_item: 'elementos de trabajo', wit_work_item_write: 'escritura de elementos',
  wit_query: 'consulta WIQL', core_list_projects: 'lista de proyectos', core_list_project_teams: 'lista de equipos',
  neo_team_members: 'integrantes del equipo', neo_team_days_off: 'días libres del equipo', neo_team_capacity_write: 'escritura de capacidad',
  neo_team_days_off_write: 'escritura de días libres', neo_work_item_states: 'estados del tipo', neo_security_read: 'seguridad',
  neo_security_login: 'inicio de sesión', neo_create_item: 'creación de elemento',
};
export function describeCall(name, args = {}) {
  const details = [args.action, Number.isInteger(args.id) ? `#${args.id}` : null, Array.isArray(args.ids) ? `${args.ids.length} elementos` : null, args.type ? `«${args.type}»` : null].filter(Boolean);
  return `${toolNames[name] || name} (${[name, ...details].join(' · ')})`;
}
