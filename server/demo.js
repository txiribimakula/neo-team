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
  return workspace;
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
