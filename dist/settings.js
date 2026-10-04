const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
export function configurationView(state) {
  const groups=new Map();
  for(const [index,rule] of (state.importRules ?? []).entries()) {
    const key=JSON.stringify([rule.organization,rule.project,rule.type]);
    if(!groups.has(key)) groups.set(key,{...rule,states:[]});
    groups.get(key).states.push({...rule,index});
  }
  return `<section class="configuration-page"><h2>Estados que se importan</h2>
    ${[...groups.values()].map(group=>`<section class="settings-card"><h2>${escape(group.type==='Task' ? 'Tareas' : group.type==='Bug' ? 'Bugs' : group.type)} <small>${escape(group.project)}</small></h2><div class="import-state-options">${group.states.map(rule=>`<button type="button" class="button import-state-option" data-action="toggle-import-state" data-import-rule="${rule.index}" aria-pressed="${rule.action==='include'}" aria-label="Importar ${escape(rule.type)} en ${escape(rule.state)} de ${escape(rule.project)}">${escape(rule.state)}</button>`).join('')}</div></section>`).join('')}</section>`;
}
