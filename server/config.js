// Connection settings typed by the person. The organization accepts its name or
// any URL copied from the browser: dev.azure.com/<org>/… or <org>.visualstudio.com.
const fail = message => Object.assign(new Error(message), { status: 400 });
const ORGANIZATION = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/;
const TENANT = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;

export function organizationFrom(value) {
  const text = String(value ?? '').trim();
  if (!/^https?:\/\//i.test(text)) return text.replace(/\/+$/, '');
  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase();
    if (host === 'dev.azure.com') return decodeURIComponent(url.pathname.split('/').find(Boolean) ?? '');
    if (host.endsWith('.visualstudio.com')) return host.slice(0, -'.visualstudio.com'.length);
  } catch { /* Reported below as an invalid organization. */ }
  return '';
}

export function configFrom(input, requireTeam = true) {
  const organization = organizationFrom(input?.organization);
  if (!ORGANIZATION.test(organization)) throw fail('Indica el nombre de tu organización o su URL https://dev.azure.com/organización.');
  const project = String(input?.project ?? '').trim(), team = String(input?.team ?? '').trim();
  if (project.length > 200 || team.length > 200) throw fail('El proyecto y el equipo admiten hasta 200 caracteres.');
  if (requireTeam && (!project || !team)) throw fail('Indica un proyecto y un equipo.');
  const authentication = input?.authentication || 'interactive';
  if (!['interactive', 'azcli'].includes(authentication)) throw fail('Método de autenticación no válido.');
  const tenant = String(input?.tenant ?? '').trim();
  if (tenant && !TENANT.test(tenant)) throw fail('El tenant debe ser un identificador de Microsoft Entra válido (formato 00000000-0000-0000-0000-000000000000).');
  return { organization, project, team, authentication, tenant };
}
