import test from 'node:test';
import assert from 'node:assert/strict';
import { inferIterationDates } from '../dist/iteration-dates.js';
const iteration=(id,name,startDate,finishDate)=>({id,name,path:`Project\\${name}`,attributes:{...(startDate ? {startDate:`${startDate}T00:00:00Z`} : {}),...(finishDate ? {finishDate:`${finishDate}T00:00:00Z`} : {})}});
const reference=iteration('ref','Semana 44-45 2026','2026-10-26','2026-11-06');
const proposal=(name,template='Semana {semana}-{semana+1} {año}',refs=[reference])=>inferIterationDates([iteration('missing',name)],template,refs).get('missing');

test('year and ISO weeks infer start weekday and duration without changing input',()=>{
  const missing=iteration('missing','Semana 46-47 2026'),input=[reference,missing],before=structuredClone(input);
  const result=inferIterationDates(input,'Semana {semana}-{semana+1} {año}').get('missing');
  assert.deepEqual([result.status,result.startDate,result.finishDate],['proposed','2026-11-09','2026-11-20']);
  assert.match(result.explanation,/no se guarda/);assert.deepEqual(input,before);
});

test('ISO weeks cross years and reject a nonexistent week or contradictory span',()=>{
  const result=proposal('Semana 53-01 2026');
  assert.equal(result.startDate,'2026-12-28');assert.equal(result.finishDate,'2027-01-08');
  assert.equal(proposal('Semana 53-01 2025').status,'ambiguous');
  assert.equal(proposal('Semana 46-49 2026').status,'ambiguous');
});

test('week-only names use bounded dated references and flag missing or ambiguous years',()=>{
  assert.equal(proposal('Semana 46-47','Semana {semana}-{semana+1}').status,'ambiguous');
  const refs=[reference,iteration('last','Última','2026-11-23','2026-12-04')];
  assert.equal(proposal('Semana 46-47','Semana {semana}-{semana+1}',refs).startDate,'2026-11-09');
  const many=[reference,iteration('last','Última','2028-11-20','2028-12-01')];
  assert.equal(proposal('Semana 46-47','Semana {semana}-{semana+1}',many).status,'ambiguous');
});

test('counters infer missing iterations using a consistent anchored cadence, including offsets',()=>{
  const refs=[iteration('one','Sprint 10','2026-10-12','2026-10-23'),iteration('two','Sprint 12','2026-11-09','2026-11-20')];
  const result=proposal('Sprint 11','Sprint {n}',refs);
  assert.deepEqual([result.startDate,result.finishDate],['2026-10-26','2026-11-06']);
  assert.match(result.explanation,/cadencia de 14 días/);
  assert.equal(proposal('Sprint 11','Sprint {n+1}',refs).startDate,'2026-10-26');
  assert.equal(proposal('Sprint 11','Sprint {n}',refs.slice(0,1)).status,'ambiguous');
  refs.push(iteration('three','Sprint 13','2026-11-30','2026-12-11'));
  assert.equal(proposal('Sprint 11','Sprint {n}',refs).status,'ambiguous');
});

test('partial dates are constraints and are never replaced, and overlaps are disclosed',()=>{
  const startOnly=iteration('one','Semana 46-47 2026','2026-11-09');
  const endOnly=iteration('two','Semana 48-49 2026',undefined,'2026-12-04');
  const incompatible=iteration('three','Semana 46-47 2026','2026-11-10');
  const result=inferIterationDates([startOnly,endOnly,incompatible],'Semana {semana}-{semana+1} {año}',[reference]);
  assert.equal(result.get('one').finishDate,'2026-11-20');
  assert.equal(result.get('two').startDate,'2026-11-23');
  assert.equal(result.get('three').status,'ambiguous');
  const overlap=proposal('Semana 44-45 2026');
  assert.equal(overlap.status,'conflict');assert.match(overlap.explanation,/solapa/);
});

test('full date names, template folders and offsets are supported',()=>{
  const dated=proposal('2026-11-09','{año}-{mes}-{día}');
  assert.equal(dated.finishDate,'2026-11-20');
  const folder=iteration('missing','Semana 46-47');folder.path='Project\\2026\\Semana 46-47';
  assert.equal(inferIterationDates([folder],'{año}\\Semana {semana}-{semana+1}',[reference]).get('missing').startDate,'2026-11-09');
  assert.equal(proposal('Semana 47 2026','Semana {semana+1} {año}').startDate,'2026-11-09');
});

test('inconsistent references, missing duration, malformed dates and folders do not receive guessed dates',()=>{
  const differentDuration=iteration('other','Other','2026-11-09','2026-11-21');
  assert.match(proposal('Semana 46-47 2026',undefined,[reference,differentDuration]).explanation,/duraciones distintas/);
  assert.equal(proposal('Semana 46-47 2026',undefined,[]).status,'ambiguous');
  assert.equal(proposal('Not a sprint').status,'ambiguous');
  const folder=iteration('folder','Semana 46-47 2026');folder.hasChildren=true;
  assert.match(inferIterationDates([folder],'Semana {semana}-{semana+1} {año}',[reference]).get('folder').explanation,/carpeta/);
  const malformed=iteration('invalid','Semana 46-47 2026','2026-02-30');
  assert.match(inferIterationDates([malformed],'Semana {semana}-{semana+1} {año}',[reference]).get('invalid').explanation,/incoherentes/);
});

test('dated parent folders do not distort iteration duration, and conflicting proposals are marked',()=>{
  const folder=iteration('folder','2026','2026-01-01','2026-12-31');folder.hasChildren=true;
  const missing=iteration('missing','Semana 46-47 2026'),duplicate=iteration('duplicate','Semana 46-47 2026');
  const result=inferIterationDates([folder,reference,missing,duplicate],'Semana {semana}-{semana+1} {año}');
  assert.equal(result.get('missing').startDate,'2026-11-09');
  assert.equal(result.get('missing').status,'conflict');
  assert.match(result.get('missing').explanation,/otra|también con la propuesta/);
});
