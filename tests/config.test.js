import test from 'node:test';
import assert from 'node:assert/strict';
import { configFrom, organizationFrom } from '../server/config.js';

test('the organization accepts its name or any URL copied from the browser',()=>{
  for (const [input,expected] of [
    ['contoso','contoso'],[' contoso/ ','contoso'],
    ['https://dev.azure.com/contoso','contoso'],['https://dev.azure.com/contoso/','contoso'],
    ['https://dev.azure.com/contoso/Project/_workitems/edit/42','contoso'],
    ['https://contoso.visualstudio.com/Project','contoso'],['http://dev.azure.com/contoso','contoso'],
  ]) assert.equal(organizationFrom(input),expected,input);
  assert.equal(organizationFrom('https://example.com/contoso'),'');
});
test('configuration errors are validation errors with a clear message',()=>{
  assert.deepEqual(configFrom({organization:'https://dev.azure.com/contoso/P',project:' P ',team:'T'}),{organization:'contoso',project:'P',team:'T',authentication:'interactive',tenant:''});
  for (const [input,message] of [
    [{organization:'bad org',project:'P',team:'T'},/organización/],
    [{organization:'org',project:'P'},/proyecto y un equipo/],
    [{organization:'org',project:'P',team:'T',authentication:'pat'},/autenticación/],
    [{organization:'org',project:'P',team:'T',tenant:'nope'},/tenant/],
  ]) assert.throws(()=>configFrom(input),error=>message.test(error.message) && error.status===400);
  assert.equal(configFrom({organization:'org'},false).project,'');
});
