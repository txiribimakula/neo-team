// The text filters share one syntax: words separated by spaces (or AND, Y, &) must
// all appear; OR, O or | gives alternatives; parentheses group, "quotes" keep a phrase
// together and a leading - leaves out what has it. AND binds tighter than OR, so
// «login pago | error» is (login AND pago) OR error.
export const normalize = value => String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es').trim();

const OR = new Set(['OR', 'O', '|', '||']), AND = new Set(['AND', 'Y', '&', '&&']);
function tokens(text) {
  const list = [], pattern = /\s*(?:(-)(?=[^\s)])|([()])|(\|\|?|&&?)|"([^"]*)"?|([^\s()|&"]+))/gy;
  let match;
  while (pattern.lastIndex < text.length && (match = pattern.exec(text))) {
    const [, not, paren, symbol, phrase, word] = match;
    if (not) list.push({ not: true });
    else if (word === '-') continue; // an exclusion still being typed
    else if (paren) list.push({ paren });
    else if (OR.has(symbol ?? word)) list.push({ or: true });
    else if (AND.has(symbol ?? word)) list.push({ and: true });
    else if (normalize(phrase ?? word)) list.push({ term: normalize(phrase ?? word) });
  }
  return list;
}
// A lenient parser: what does not close or has nothing on one side is left out, so a
// half-typed query still filters by what it already says.
function parse(list) {
  let at = 0;
  function or() {
    const options = [];
    for (;;) {
      const node = and();
      if (node) options.push(node);
      if (!list[at]?.or) return options.length < 2 ? options[0] ?? null : { or: options };
      at++;
    }
  }
  function and() {
    const all = [];
    while (at < list.length && !list[at].or && list[at].paren !== ')') {
      if (list[at].and) { at++; continue; }
      const node = unary();
      if (node) all.push(node);
    }
    return all.length < 2 ? all[0] ?? null : { and: all };
  }
  function unary() {
    const token = list[at++];
    if (token.not) { const node = at < list.length && !list[at].or && !list[at].and && list[at].paren !== ')' ? unary() : null; return node && { not: node }; }
    if (token.paren === '(') { const node = or(); if (list[at]?.paren === ')') at++; return node; }
    return token.term ? token : null;
  }
  const nodes = [];
  while (at < list.length) { const node = or(); if (node) nodes.push(node); at++; }
  return nodes.length < 2 ? nodes[0] ?? null : { and: nodes };
}
function evaluate(node, test) {
  if (node.term) return test(node.term);
  if (node.not) return !evaluate(node.not, test);
  if (node.or) return node.or.some(child => evaluate(child, test));
  return node.and.every(child => evaluate(child, test));
}
// The query typed, ready to test each item: null when it asks for nothing. `test`
// receives each normalized term; by default, whether the text holds it.
const cache = new Map();
export function compileQuery(text) {
  const key = String(text ?? '');
  if (!cache.has(key)) {
    if (cache.size > 50) cache.clear();
    const node = parse(tokens(key));
    cache.set(key, node && (subject => evaluate(node, typeof subject === 'function' ? subject : term => subject.includes(term))));
  }
  return cache.get(key);
}
// Whether `subject` (already normalized text, or a test per term) passes the query.
export const matchesQuery = (text, subject) => compileQuery(text)?.(subject) ?? true;
