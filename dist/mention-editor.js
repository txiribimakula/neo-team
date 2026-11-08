// Selected mentions carry their identity in an indivisible, noneditable chip.
// Plain @names stay plain text; only chips serialize to Azure's @<identity>.
const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const TOKEN = /@<([^<>\s]+)>/g;
const MAX = 4000;
let labelFor = identity => identity === 'asignado' ? 'Asignado' : identity;
export function mentionMarkup(text, label = labelFor) {
  text=String(text ?? '');
  let html='',end=0;
  for (const match of String(text).matchAll(TOKEN)) {
    html+=escape(text.slice(end,match.index));
    html+=`<span class="mention-token" contenteditable="false" data-mention="${escape(match[1])}" title="Mención a ${escape(label(match[1]))}. Se borra como un bloque.">@${escape(label(match[1]))}</span>`;
    end=match.index+match[0].length;
  }
  return html+escape(String(text).slice(end));
}
export function commentEditor(id,text,label,compact=false) {
  return `<div class="mention-editor ${compact ? 'compact' : ''}" contenteditable="true" role="textbox" aria-multiline="true" aria-label="${escape(label)}" data-comment-for="${escape(id)}" data-focus="comment:${escape(id)}" data-placeholder="Comentario… @ para mencionar">${mentionMarkup(text)}</div>`;
}
function textOf(node) {
  if (node.nodeType===3) return node.data;
  if (node.nodeType===1 && node.hasAttribute('data-mention')) return `@<${node.dataset.mention}>`;
  if (node.nodeName==='BR') return '\n';
  return [...node.childNodes].map(textOf).join('');
}
export const commentText = editor => textOf(editor);
export function commentSelection(editor) {
  const selection=editor.ownerDocument.getSelection();
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return {start:commentText(editor).length,end:commentText(editor).length};
  const range=selection.getRangeAt(0),prefix=editor.ownerDocument.createRange();
  prefix.selectNodeContents(editor);prefix.setEnd(range.startContainer,range.startOffset);
  let start=textOf(prefix.cloneContents()).length;
  const parent=range.startContainer.nodeType===1 ? range.startContainer : range.startContainer.parentElement;
  const token=parent?.closest?.('[data-mention]');
  if (!range.collapsed && token && editor.contains(token)) start-=textOf(token).length;
  prefix.setEnd(range.endContainer,range.endOffset);
  return {start,end:textOf(prefix.cloneContents()).length};
}
function segments(editor) {
  const result=[];let offset=0;
  function visit(node) {
    if (node.nodeType===3 || node.nodeName==='BR' || (node.nodeType===1 && node.hasAttribute('data-mention'))) {
      const length=textOf(node).length;result.push({node,start:offset,end:offset+length,token:node.nodeType===1 && node.hasAttribute('data-mention')});offset+=length;
    } else for (const child of node.childNodes) visit(child);
  }
  visit(editor);return result;
}
export function setCommentSelection(editor,start,end=start) {
  const range=editor.ownerDocument.createRange(),parts=segments(editor);
  function place(offset,edge) {
    const part=parts.find(p=>offset<=p.end);
    if (!part) { range[edge==='start' ? 'setStart' : 'setEnd'](editor,editor.childNodes.length);return; }
    const method=edge==='start' ? 'setStart' : 'setEnd';
    if (part.node.nodeType===3) range[method](part.node,Math.max(0,offset-part.start));
    else range[method+(offset<=part.start ? 'Before' : 'After')](part.node);
  }
  place(start,'start');place(end,'end');
  const selection=editor.ownerDocument.getSelection();selection.removeAllRanges();selection.addRange(range);
}
const histories=new WeakMap();
function snapshot(editor) { return {text:commentText(editor),...commentSelection(editor)}; }
function history(editor) {
  if (!histories.has(editor)) histories.set(editor,{last:snapshot(editor),undo:[],redo:[],suppress:false});
  return histories.get(editor);
}
function changed(editor) { editor.dispatchEvent(new Event('input',{bubbles:true})); }
export function replaceCommentRange(editor,start,end,text) {
  const state=history(editor);state.last=snapshot(editor);
  const current=commentText(editor);
  if (current.length-(end-start)+text.length>MAX) return false;
  editor.innerHTML=mentionMarkup(current.slice(0,start)+text+current.slice(end));
  editor.focus();setCommentSelection(editor,start+text.length);changed(editor);return true;
}
function atomicRange(editor,start,end) {
  for (const part of segments(editor).filter(p=>p.token)) {
    if (start<part.end && end>part.start) { start=Math.min(start,part.start);end=Math.max(end,part.end); }
    else if (start===end && start>part.start && start<part.end) { start=part.start;end=part.end; }
  }
  return {start,end};
}
export function installMentionEditors(document,resolveLabel) {
  labelFor=resolveLabel;
  const find=event=>event.target.closest?.('.mention-editor');
  document.addEventListener('beforeinput',event=>{
    const editor=find(event);if(!editor)return;
    const state=history(editor);state.last=snapshot(editor);
    if(event.isComposing)return;
    if(event.inputType.startsWith('format')) {event.preventDefault();return;}
    let {start,end}=commentSelection(editor);
    ({start,end}=atomicRange(editor,start,end));
    if(start===end && ['deleteContentBackward','deleteContentForward'].includes(event.inputType)) {
      const token=segments(editor).find(p=>p.token && (event.inputType==='deleteContentBackward' ? p.end===start : p.start===end));
      if(token){start=token.start;end=token.end;}
    }
    if(event.inputType==='insertParagraph' || event.inputType==='insertLineBreak') {event.preventDefault();replaceCommentRange(editor,start,end,'\n');return;}
    if(event.inputType.startsWith('delete') && start!==end) {event.preventDefault();replaceCommentRange(editor,start,end,'');return;}
    if(start!==end) setCommentSelection(editor,start,end);
    if(event.data && commentText(editor).length-(end-start)+event.data.length>MAX) event.preventDefault();
  });
  document.addEventListener('input',event=>{
    const editor=find(event);if(!editor)return;
    const state=history(editor);
    if(editor.innerHTML==='<br>')editor.replaceChildren();
    const next=snapshot(editor);
    if(!state.suppress && next.text!==state.last.text){state.undo.push(state.last);state.redo=[];}
    state.last=next;
  },true);
  document.addEventListener('keydown',event=>{
    const editor=find(event);if(!editor)return;
    if((event.ctrlKey||event.metaKey) && ['b','i','u'].includes(event.key.toLowerCase())) {event.preventDefault();return;}
    if((event.ctrlKey||event.metaKey) && ['z','y'].includes(event.key.toLowerCase())) {
      event.preventDefault();const state=history(editor),redo=event.key.toLowerCase()==='y'||event.shiftKey;
      const from=redo?state.redo:state.undo,to=redo?state.undo:state.redo,previous=from.pop();if(!previous)return;
      to.push(snapshot(editor));state.suppress=true;editor.innerHTML=mentionMarkup(previous.text);setCommentSelection(editor,previous.start,previous.end);changed(editor);state.suppress=false;return;
    }
    if(['ArrowLeft','ArrowRight'].includes(event.key) && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const {start,end}=commentSelection(editor),token=segments(editor).find(p=>p.token && (event.key==='ArrowLeft' ? p.start<start && p.end>=start : p.start<=end && p.end>end));
      if(token){event.preventDefault();setCommentSelection(editor,event.key==='ArrowLeft'?token.start:token.end);}
    }
  });
  for(const type of ['copy','cut'])document.addEventListener(type,event=>{
    const editor=find(event);if(!editor)return;
    const selected=commentSelection(editor),{start,end}=atomicRange(editor,selected.start,selected.end);if(start===end)return;
    const text=commentText(editor).slice(start,end);
    event.clipboardData.setData('text/plain',text.replace(TOKEN,(_,id)=>`@${labelFor(id)}`));
    event.clipboardData.setData('application/x-neo-mentions',text);event.preventDefault();
    if(type==='cut')replaceCommentRange(editor,start,end,'');
  });
  document.addEventListener('paste',event=>{
    const editor=find(event);if(!editor)return;event.preventDefault();
    const range=commentSelection(editor),{start,end}=atomicRange(editor,range.start,range.end);
    const text=event.clipboardData.getData('application/x-neo-mentions')||event.clipboardData.getData('text/plain');
    replaceCommentRange(editor,start,end,text);
  });
  document.addEventListener('drop',event=>{const editor=find(event);if(editor)event.preventDefault();});
}
