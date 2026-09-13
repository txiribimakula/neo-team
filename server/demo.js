import { normalizeItem } from './planner.js';
export function createDemo() {
  const monday = new Date(); monday.setUTCHours(0,0,0,0); monday.setUTCDate(monday.getUTCDate() + ((8 - monday.getUTCDay()) % 7 || 7));
  const date = offset => new Date(+monday + offset * 86400000).toISOString();
  const iterations = [
    { id: 'sprint-24', name: 'Iteración 24', path: 'Neo Platform\\Iteración 24', attributes: { startDate: date(0), finishDate: date(11), timeFrame: 1 } },
    { id: 'sprint-25', name: 'Iteración 25', path: 'Neo Platform\\Iteración 25', attributes: { startDate: date(14), finishDate: date(25), timeFrame: 2 } },
  ];
  const members = [
    { id: 'ana', displayName: 'Ana García', uniqueName: 'ana@example.test' },
    { id: 'marcos', displayName: 'Marcos Ruiz', uniqueName: 'marcos@example.test' },
    { id: 'lucia', displayName: 'Lucía Martín', uniqueName: 'lucia@example.test' },
    { id: 'david', displayName: 'David López', uniqueName: 'david@example.test' },
  ];
  const specs = [
    [1042, 'Unificar los filtros del panel de actividad', 'Task', 0, 12, 'Frontend', 2, true],
    [1045, 'Ajustar el menú de navegación en móvil', 'Task', 0, 8, 'Accesibilidad', 2, true],
    [1038, 'Añadir paginación al historial de eventos', 'Task', 1, 16, 'API', 2, true],
    [1047, 'Corregir el timeout al exportar informes', 'Bug', 1, null, 'Rendimiento', 1, true],
    [1040, 'Validar permisos de acceso por equipo', 'Task', 2, 20, 'Seguridad', 1, true],
    [1049, 'Cubrir la recuperación de contraseña', 'Task', 2, 12, 'QA', 2, true],
    [1044, 'Preparar métricas del nuevo servicio', 'Task', 3, 16, 'Plataforma', 2, true],
    [1053, 'Revisar los estados vacíos de proyectos', 'Task', -1, 6, 'Diseño', 3, false],
    [1054, 'Actualizar las dependencias del cliente', 'Task', -1, 8, 'Mantenimiento', 3, false],
    [1056, 'Mejorar la búsqueda de integrantes', 'User Story', -1, null, 'Producto', 2, false],
    [1057, 'Corregir el orden de las notificaciones', 'Bug', -1, null, 'Frontend', 2, false],
    [1059, 'Documentar el despliegue del servicio', 'Task', -1, 4, 'Documentación', 4, false],
    [1061, 'Añadir pruebas de integración de equipos', 'Task', -1, 10, 'QA', 2, true],
  ];
  const items = specs.map(([id,title,type,person,hours,tag,priority,scheduled]) => normalizeItem({ id, rev: 1, fields: {
    'System.Title': title, 'System.WorkItemType': type, 'System.State': 'New',
    'System.TeamProject': 'Neo Platform', 'System.AreaPath': 'Neo Platform\\Producto',
    'System.IterationPath': scheduled ? iterations[0].path : 'Neo Platform',
    'System.AssignedTo': members[person] || '', 'Microsoft.VSTS.Common.Priority': priority,
    ...(hours !== null ? { 'Microsoft.VSTS.Scheduling.RemainingWork': hours } : {}),
    ...(type === 'User Story' ? { 'Microsoft.VSTS.Scheduling.StoryPoints': 5 } : {}), 'System.Tags': tag,
  } }));
  const capacities = Object.fromEntries(iterations.map(i => [i.id, { daysOff: [], teamMembers: members.map((m, index) => ({ teamMember: m, activities: [{ name: 'Development', capacityPerDay: [5,6,4,6][index] }], daysOff: index === 2 ? [{ start: date(0), end: date(1) }] : [] })) }]));
  const workspace = { mode: 'demo', importedAt: new Date().toISOString(), config: { organization: 'ejemplo', project: 'Neo Platform', team: 'Equipo de producto' },
    settings: { backlogIteration: { path: 'Neo Platform' }, workingDays: [1,2,3,4,5] }, iterations, members, capacities, items, drafts: {}, conflicts: {}, warnings: [] };
  upgradeDemoHierarchy(workspace);
  upgradeDemoPreviousIteration(workspace);
  return workspace;
}

export const DEMO_STATES = [['New', 'proposed'], ['Active', 'inprogress'], ['Resolved', 'resolved'], ['Closed', 'completed'], ['Removed', 'removed']].map(([name, category]) => ({ name, category }));
export function demoFunctionalIssues(settings) {
  const day = offset => new Date(Date.now() - offset * 86400000).toISOString();
  const issues = [
    [2101, 'El informe mensual no incluye los proyectos archivados', 'Active', 'Ana García', 1, 1, ['Informes']],
    [2107, 'El aviso de sesión caducada aparece dos veces', 'Active', 'Marcos Ruiz', 2, 0, ['Sesión']],
    [2104, 'La búsqueda ignora las tildes en los nombres', 'New', '', 2, 3, ['Búsqueda']],
    [2110, 'Los filtros guardados se pierden al cambiar de equipo', 'New', 'Lucía Martín', 2, 6, []],
    [2112, 'La exportación a CSV duplica la cabecera', 'Resolved', 'David López', 2, 2, ['Exportación']],
    [2113, 'Texto cortado en el menú en pantallas pequeñas', 'New', '', 3, 9, ['Móvil']],
    [2098, 'El logo no se ve en modo oscuro', 'Closed', 'Ana García', 3, 15, []],
  ].filter(([, , state]) => !settings.closedStates.includes(state))
    .map(([id, title, state, assignedTo, priority, changed, tags]) => ({ id, title, state, category: settings.states.find(s => s.name === state)?.category ?? '', assignedTo, areaPath: 'Neo Platform\\Producto', iterationPath: 'Neo Platform', priority, createdAt: day(changed + 20), changedAt: day(changed), tags }));
  return { type: settings.type, closedStates: settings.closedStates, fetchedAt: new Date().toISOString(), limited: false, demo: true, organization: 'ejemplo', project: 'Neo Platform', issues };
}

// A finished iteration with open work, reviewed before planning the next one.
export function upgradeDemoPreviousIteration(workspace) {
  if (!workspace || workspace.mode !== 'demo' || workspace.demoPreviousVersion === 1) return false;
  const first = workspace.iterations.map(i => Date.parse(i.attributes?.startDate)).filter(Number.isFinite).sort((a, b) => a - b)[0] ?? Date.now();
  const date = offset => new Date(first + offset * 86400000).toISOString();
  const path = 'Neo Platform\\Iteración 23';
  if (!workspace.iterations.some(i => i.id === 'sprint-23')) workspace.iterations.push({ id: 'sprint-23', name: 'Iteración 23', path, past: true, attributes: { startDate: date(-14), finishDate: date(-3), timeFrame: 0 } });
  const members = new Map(workspace.members.map(m => [m.uniqueName, m]));
  const specs = [
    [1030, 'Migrar el registro de auditoría al nuevo almacén', 'Task', 'ana@example.test', 'Active', 6, 1004],
    [1031, 'Revisar el contraste de los botones secundarios', 'Task', 'marcos@example.test', 'Active', 3, 1001],
    [1032, 'Error al guardar filtros vacíos', 'Bug', 'marcos@example.test', 'New', 2, 1002],
    [1033, 'Automatizar la copia de seguridad semanal', 'Task', 'david@example.test', 'Active', 5, 1004],
    [1034, 'Probar el bloqueo tras intentos fallidos', 'Task', 'lucia@example.test', 'Active', 4, 1003],
    [1035, 'Revisar los textos de bienvenida', 'Task', '', 'New', 2, 1001],
  ];
  for (const [id, title, type, owner, state, hours, parent] of specs) {
    if (workspace.items.some(i => i.id === id)) continue;
    workspace.items.push(normalizeItem({ id, rev: 1, fields: {
      'System.Title': title, 'System.WorkItemType': type, 'System.State': state, 'System.TeamProject': 'Neo Platform', 'System.AreaPath': 'Neo Platform\\Producto',
      'System.IterationPath': path, 'System.AssignedTo': members.get(owner) || '', 'System.Parent': parent,
      'Microsoft.VSTS.Common.Priority': 2, 'Microsoft.VSTS.Scheduling.RemainingWork': hours,
    } }));
  }
  workspace.completedStates ??= { Task: 'Closed', Bug: 'Closed' };
  workspace.demoPreviousVersion = 1;
  return true;
}

export function upgradeDemoHierarchy(workspace) {
  if (!workspace || workspace.mode !== 'demo' || workspace.demoHierarchyVersion === 1) return false;
  const specs = [
    [900,'Una plataforma más fácil de usar','Epic',null],
    [910,'Experiencia de producto','Feature',900],
    [920,'Fiabilidad y acceso','Feature',900],
    [1001,'Navegación y actividad del equipo','User Story',910],
    [1002,'Búsqueda y notificaciones','User Story',910],
    [1003,'Acceso seguro y recuperación','User Story',920],
    [1004,'Operación y mantenimiento del servicio','User Story',920],
  ];
  for (const [id,title,type,parent] of specs) {
    if (!workspace.items.some(i=>i.id === id)) workspace.items.push(normalizeItem({id,rev:1,fields:{'System.Title':title,'System.WorkItemType':type,'System.Parent':parent,'System.IterationPath':workspace.settings.backlogIteration.path,'System.State':'New','Microsoft.VSTS.Common.Priority':2}}));
  }
  const parents={1042:1001,1045:1001,1038:1002,1047:1004,1040:1003,1049:1003,1044:1004,1053:1001,1054:1004,1056:910,1057:1002,1059:1004,1061:1003};
  for (const item of workspace.items) if (!item.parent && parents[item.id]) item.parent=parents[item.id];
  workspace.participants ??= {1001:['ana@example.test','marcos@example.test'],1002:['marcos@example.test'],1003:['lucia@example.test'],1004:['david@example.test','marcos@example.test']};
  workspace.demoHierarchyVersion=1;
  return true;
}
