// The model and the reasoning effort of a place that asks GitHub Copilot: the
// account's models (× is their cost multiplier) and the efforts that the model that
// will answer supports. Empty is automatic: the default model, or its default effort.
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const EFFORT_LABELS = { low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Muy alto', max: 'Máximo' };
export const effortName = effort => EFFORT_LABELS[effort] ?? effort;

// `attrs` identify the place (data-ai-choice…) and `name` says whose it is («del agente…»); `automatic`: the model used without a choice, if
// known, and `hint` what is said of it when not.
export function aiChoice({ attrs, models = [], model = '', effort = '', automatic = null, hint = null, auto = 'Auto', name, modelClass = '', disabled = false }) {
  const list = [...(model && !models.some(m => m.id === model) ? [{ id: model, name: model }] : []), ...models];
  const answering = models.find(m => m.id === (model || automatic));
  const efforts = answering?.efforts ?? [], chosen = efforts.includes(effort) ? effort : '';
  const modelTitle = `Modelo · ${model || (automatic || hint ? `Auto: ${automatic || hint}` : auto)}`;
  const effortTitle = disabled ? 'Esfuerzo' : !answering ? 'Esfuerzo · el predeterminado del modelo' : !efforts.length ? `Esfuerzo · ${answering.name} no permite elegirlo` : `Esfuerzo · ${chosen ? effortName(chosen) : `Auto${answering.defaultEffort ? `: ${effortName(answering.defaultEffort)}` : ''}`}`;
  return `<span class="ai-choice" ${attrs}><select class="ai-model ${modelClass}" data-ai="model" aria-label="Modelo ${escape(name)}" title="${escape(modelTitle)}" ${disabled ? 'disabled' : ''}><option value="">${escape(auto)}</option>${list.map(m => `<option value="${escape(m.id)}" ${m.id === model ? 'selected' : ''}>${escape(m.name)}${m.multiplier != null ? ` · ×${m.multiplier}` : ''}</option>`).join('')}</select><select class="ai-effort" data-ai="effort" aria-label="Esfuerzo ${escape(name)}" title="${escape(effortTitle)}" ${disabled || !efforts.length ? 'disabled' : ''}><option value="">Auto</option>${efforts.map(e => `<option value="${e}" ${e === chosen ? 'selected' : ''}>${effortName(e)}</option>`).join('')}</select></span>`;
}
