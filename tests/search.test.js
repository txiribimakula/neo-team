import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesQuery, compileQuery } from '../dist/search.js';
import { matchesText } from '../dist/maintenance-items.js';

test('the searches take AND, OR, parentheses, phrases and exclusions', () => {
  const cases = [
    ['', 'login pago', true], ['login', 'pantalla de login', true],
    ['login pago', 'pago y login', true], ['login pago', 'login sin', false], ['login AND pago', 'login', false], ['a Y b', 'a', false], ['a & b', 'a b', true],
    ['login OR pago', 'pago', true], ['login | pago', 'nada', false], ['a O b', 'b', true],
    ['a b | c d', 'c d', true], ['a b | c d', 'a d', false],
    ['(login | alta) error', 'alta con error', true], ['(login | alta) error', 'alta', false],
    ['-login', 'pago', true], ['-login', 'login', false], ['error -(login | alta)', 'error en alta', false], ['error -(login | alta)', 'error en pago', true],
    ['"crear usuario"', 'al crear usuario', true], ['"crear usuario"', 'crear el usuario', false],
    ['Canción', 'cancion nueva', true], ['pre-produccion', 'en pre-produccion', true],
  ];
  for (const [query, text, expected] of cases) assert.equal(matchesQuery(query, text), expected, `«${query}» on «${text}»`);
});

test('a half-typed query filters by what it already says', () => {
  for (const query of ['login OR', 'login AND', '(login', 'login)', '| login', '-']) assert.equal(matchesQuery(query, 'pantalla de login'), true, query);
  for (const query of ['', '  ', 'OR', 'AND', '()', '""']) assert.equal(compileQuery(query), null, `«${query}» asks for nothing`);
  assert.equal(matchesQuery('login', term => term === 'login'), true, 'a test per term decides each word');
});

test('Mantenimiento searches every field with the same syntax', () => {
  const item = { label: 'APP-1', title: 'Error al guardar', assignedTo: 'Ana', state: 'Abierto', tags: ['web'], values: {} };
  assert.equal(matchesText(item, 'guardar ana'), true);
  assert.equal(matchesText(item, 'imprimir | web'), true);
  assert.equal(matchesText(item, 'guardar -web'), false);
});
