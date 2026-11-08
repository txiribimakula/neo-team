import test from 'node:test';
import assert from 'node:assert/strict';
import {mentionMarkup,commentEditor,commentText,replaceCommentRange} from '../dist/mention-editor.js';
import {addComment,addComments} from '../server/planner.js';
import {createDemo} from '../server/demo.js';
const text=value=>({nodeType:3,data:value});
const chip=(id,label)=>({nodeType:1,dataset:{mention:id},hasAttribute:name=>name==='data-mention',childNodes:[text('@'+label)]});
const root=nodes=>({nodeType:11,childNodes:nodes});

test('selected mentions render the entire name as a noneditable block; ordinary similar names stay plain',()=>{
  const html=mentionMarkup('Hola @<ana@example.test> y @Ana García.',()=> 'Ana García');
  assert.match(html,/contenteditable="false" data-mention="ana@example.test"/);
  assert.match(html,/>@Ana García<\/span> y @Ana García\./);
  assert.equal((html.match(/class="mention-token"/g)??[]).length,1);
});

test('mentions keep distinct identities even when display names coincide',()=>{
  const html=mentionMarkup('@<first@example.test> @<second@example.test>',()=> 'Ana García');
  assert.match(html,/data-mention="first@example.test"/);assert.match(html,/data-mention="second@example.test"/);
  const editor=root([chip('first@example.test','Ana García'),text(' y '),chip('second@example.test','Ana García')]);
  assert.equal(commentText(editor),'@<first@example.test> y @<second@example.test>');
});

test('serialization reads only mention chips as identities and preserves multiline ordinary text',()=>{
  const editor=root([text('Hola '),chip('ana@example.test','Ana García'),text('\n@Ana García como texto'),{nodeType:1,nodeName:'BR',hasAttribute:()=>false}]);
  assert.equal(commentText(editor),'Hola @<ana@example.test>\n@Ana García como texto\n');
});

test('editor markup escapes names, identities and comment content without inserting executable HTML',()=>{
  const html=mentionMarkup('<img src=x onerror=alert(1)> @<a"b@example.test>',()=>'<script>Bad</script>');
  assert.doesNotMatch(html,/<img|<script|onerror="/);
  assert.match(html,/&lt;img/);assert.match(html,/data-mention="a&quot;b@example.test"/);
  assert.match(html,/@&lt;script&gt;Bad&lt;\/script&gt;/);
  const editor=commentEditor('42','@<ana@example.test>','Comentario de "Ana"');
  assert.match(editor,/role="textbox" aria-multiline="true"/);assert.match(editor,/aria-label="Comentario de &quot;Ana&quot;"/);
});

test('oversized insertions are rejected intact, preserving the mention identity and draft',()=>{
  const editor=root([chip('ana@example.test','Ana García')]);editor.ownerDocument={getSelection:()=>null};
  const before=commentText(editor);
  assert.equal(replaceCommentRange(editor,0,0,'x'.repeat(4001)),false);
  assert.equal(commentText(editor),before);
});

test('single and bulk comments preserve selected identities and do not replace ordinary @names',()=>{
  const ws=createDemo(),body='Hola @<ana@example.test> y @Ana García como texto.';
  addComment(ws,1042,body);
  assert.equal(ws.pendingComments.at(-1).text,body);
  addComments(ws,[1042,1038],'@<asignado> revisa con @<lucia@example.test>.');
  assert.equal(ws.pendingComments.at(-2).text,'@<ana@example.test> revisa con @<lucia@example.test>.');
  assert.equal(ws.pendingComments.at(-1).text,'@<marcos@example.test> revisa con @<lucia@example.test>.');
});
