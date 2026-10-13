// The model and the reasoning effort of each place that asks GitHub Copilot.
// Each model supports some efforts (or none); empty is the default of the model.
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// What the person chose, checked: null when it is not valid.
export function choiceFrom(input) {
  const model = typeof input?.model === 'string' ? input.model.trim() : '';
  const effort = typeof input?.effort === 'string' ? input.effort : '';
  if (model.length > 100 || (model && !/^[\w.:/-]+$/.test(model))) return null;
  if (effort && !EFFORTS.includes(effort)) return null;
  return { model, effort };
}

// The effort a session may ask for: only one the model supports. Without the list
// of models (not checked yet) the choice goes as it is; without a known model, none.
export function effortFor(model, effort, models = []) {
  if (!EFFORTS.includes(effort) || !model) return null;
  if (!models.length) return effort;
  return models.find(m => m.id === model)?.efforts?.includes(effort) ? effort : null;
}

// A model of the account as the interface lists it: its efforts too.
export const modelInfo = m => ({ id: m.id, name: m.name || m.id, multiplier: m.billing?.multiplier ?? null,
  efforts: (m.supportedReasoningEfforts ?? []).filter(e => EFFORTS.includes(e)), defaultEffort: m.defaultReasoningEffort ?? null });
