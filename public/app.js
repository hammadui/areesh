const $ = (s) => document.querySelector(s);
const state = { token: sessionStorage.getItem('marginalia_token') || '', papers: [], current: null, annotations: [] };
const paperDialog = $('#paper-dialog');
const detailDialog = $('#detail-dialog');
const annotationDialog = $('#annotation-dialog');
const escapeHtml = (v = '') => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statusLabels = {'to-read':'To read',reading:'Reading',read:'Read',reference:'Reference'};
const colorMap = {yellow:'#f2cf42',green:'#58bd7b',pink:'#f18ab2',blue:'#68aef3',orange:'#efa24d'};
function setConnection(text, good=false) { const el=$('#connection'); el.textContent=text; el.classList.toggle('muted',!good); }
function showNotice(text, bad=false) { const el=$('#notice'); el.textContent=text; el.classList.remove('hidden','bad'); if(bad) el.classList.add('bad'); }
function hideNotice(){ $('#notice').classList.add('hidden'); }
async function api(url, options={}) {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set('Authorization', `Bearer ${state.token}`);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type','application/json');
  const response = await fetch(url,{...options,headers});
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : response;
  if (!response.ok) {
    if(response.status===401 && !url.endsWith('/api/auth/login')) signOut(false);
    throw new Error(body?.error || `Request failed (${response.status})`);
  }
  return body;
}
function signedIn(email) {
  $('#login-screen').classList.add('hidden'); $('#app-screen').classList.remove('hidden');
  $('#logout').classList.remove('hidden'); setConnection(email || 'Signed in',true);
}
function signOut(show=true) {
  state.token=''; state.papers=[]; state.current=null; sessionStorage.removeItem('marginalia_token');
  $('#app-screen').classList.add('hidden'); $('#login-screen').classList.remove('hidden'); $('#logout').classList.add('hidden');
  setConnection('Signed out');
  if(show) $('#login-error').textContent='You have signed out.';
}
async function initialise() {
  try {
    const r=await fetch('/api/health'); if(!r.ok) throw new Error();
    setConnection('Service online',true);
    if(state.token) {
      try { const me=await api('/api/auth/me'); signedIn(me.user.email); await loadPapers(); }
      catch { signOut(false); }
    }
  } catch { setConnection('API unavailable'); $('#login-error').textContent='The server is not reachable. Start the Node.js server and reload.'; }
}
$('#login-form').addEventListener('submit', async e=>{
  e.preventDefault(); $('#login-error').textContent='';
  const data=new FormData(e.currentTarget);
  try {
    const result=await api('/api/auth/login',{method:'POST',body:JSON.stringify({email:data.get('email'),password:data.get('password')})});
    state.token=result.token; sessionStorage.setItem('marginalia_token',state.token);
    signedIn(result.user.email); await loadPapers(); e.currentTarget.reset();
  } catch(err) { $('#login-error').textContent=err.message; }
});
$('#logout').addEventListener('click',()=>signOut());
$('#search').addEventListener('input',()=>renderPapers());
$('#new-paper').addEventListener('click',()=>openPaperForm());
$('#empty-add').addEventListener('click',()=>openPaperForm());
$('#upload-library-pdf-button').addEventListener('click',()=>$('#library-pdf-upload').click());
$('#empty-upload-pdf').addEventListener('click',()=>$('#library-pdf-upload').click());
$('#library-pdf-upload').addEventListener('change',uploadNewPdfFromLibrary);
$('#close-paper').addEventListener('click',()=>paperDialog.close());
$('#cancel-paper').addEventListener('click',()=>paperDialog.close());
$('#close-detail').addEventListener('click',()=>detailDialog.close());
$('#done-detail').addEventListener('click',()=>detailDialog.close());
$('#close-annotation').addEventListener('click',()=>annotationDialog.close());
$('#cancel-annotation').addEventListener('click',()=>annotationDialog.close());
$('#paper-form').addEventListener('submit',savePaper);
$('#annotation-form').addEventListener('submit',saveAnnotation);
$('#edit-current').addEventListener('click',()=>{const p=state.current;detailDialog.close();openPaperForm(p);});
$('#add-annotation').addEventListener('click',()=>openAnnotationForm());
$('#pdf-upload').addEventListener('change',uploadPdf);
$('#open-pdf').addEventListener('click',openPdf);
$('#delete-current').addEventListener('click',deleteCurrent);

async function loadPapers() {
  const data=await api('/api/papers'); state.papers=data.papers; renderPapers();
}
function renderPapers() {
  const q=$('#search').value.trim().toLowerCase();
  const visible=state.papers.filter(p=>[p.title,p.authors,p.journal,...(p.tags||[])].join(' ').toLowerCase().includes(q));
  $('#paper-count').textContent=`${visible.length} paper${visible.length===1?'':'s'}`;
  $('#paper-list').innerHTML=visible.map(p=>`<article class="paper-card">
    <div><h2 class="paper-title">${escapeHtml(p.title)}</h2>
    <p class="paper-meta">${escapeHtml([p.authors,p.year,p.journal].filter(Boolean).join(' · ')||'No citation details yet')}</p>
    <div class="tags"><span class="status">${escapeHtml(statusLabels[p.status]||p.status||'To read')}</span>${p.hasPdf?'<span class="tag">PDF attached</span>':'<span class="tag">No PDF</span>'}${(p.tags||[]).map(t=>`<span class="tag">${escapeHtml(t)}</span>`).join('')}</div></div>
    <div class="paper-actions"><button class="button secondary" data-open="${p.id}">Open workspace</button>${p.hasPdf?`<button class="button secondary" data-pdf="${p.id}">Open PDF</button>`:''}</div></article>`).join('');
  $('#paper-list').querySelectorAll('[data-open]').forEach(b=>b.addEventListener('click',()=>openDetails(b.dataset.open)));
  $('#paper-list').querySelectorAll('[data-pdf]').forEach(b=>b.addEventListener('click',()=>openPaperPdf(b.dataset.pdf)));
  $('#empty-state').classList.toggle('hidden',visible.length>0);
  $('#paper-list').classList.toggle('hidden',visible.length===0);
}
function openPaperForm(p=null) {
  const f=$('#paper-form'); f.reset(); $('#paper-form-error').textContent='';
  $('#paper-dialog-title').textContent=p?'Edit paper':'Add a paper';
  f.elements.id.value=p?.id||''; f.elements.title.value=p?.title||''; f.elements.authors.value=p?.authors||'';
  f.elements.year.value=p?.year||''; f.elements.journal.value=p?.journal||''; f.elements.doi.value=p?.doi||'';
  f.elements.tags.value=(p?.tags||[]).join(', '); f.elements.status.value=p?.status||'to-read';
  f.elements.abstract.value=p?.abstract||''; f.elements.notes.value=p?.notes||'';
  paperDialog.showModal();
}
async function savePaper(e) {
  e.preventDefault(); const f=e.currentTarget; const id=f.elements.id.value;
  const payload={title:f.elements.title.value,authors:f.elements.authors.value,year:f.elements.year.value,journal:f.elements.journal.value,doi:f.elements.doi.value,tags:f.elements.tags.value.split(',').map(s=>s.trim()).filter(Boolean),status:f.elements.status.value,abstract:f.elements.abstract.value,notes:f.elements.notes.value};
  try {
    const result=await api(id?`/api/papers/${id}`:'/api/papers',{method:id?'PATCH':'POST',body:JSON.stringify(payload)});
    paperDialog.close(); await loadPapers(); showNotice(id?'Paper updated.':'Paper added to your private library.');
    if(id && state.current?.id===id) await openDetails(id);
    else if(!id) await openDetails(result.paper.id);
  } catch(err) { $('#paper-form-error').textContent=err.message; }
}
async function openDetails(id) {
  try {
    const {paper}=await api(`/api/papers/${id}`); state.current=paper;
    $('#detail-title').textContent=paper.title;
    $('#detail-meta').textContent=[paper.authors,paper.year,paper.journal,paper.doi?`DOI ${paper.doi}`:''].filter(Boolean).join(' · ');
    $('#detail-abstract').textContent=paper.abstract||'No abstract added.';
    $('#detail-notes').textContent=paper.notes||'No research notes yet.';
    $('#open-pdf').disabled=!paper.hasPdf; $('#pdf-upload').value='';
    const {annotations}=await api(`/api/papers/${id}/annotations`); state.annotations=annotations;
    renderAnnotations(); detailDialog.showModal();
  } catch(err) { showNotice(err.message,true); }
}
function renderAnnotations() {
  const list=$('#annotation-list');
  if(!state.annotations.length){list.innerHTML='<p class="annotation-empty">No annotations yet. Save a passage, comment or reading note here.</p>';return;}
  list.innerHTML=[...state.annotations].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(a=>`<article class="annotation-card">
    <div class="annotation-head"><span class="annotation-type">${escapeHtml(a.type)}</span><span class="annotation-page">Page ${Number(a.page)||1}</span><span class="annotation-page">${new Date(a.updatedAt||a.createdAt).toLocaleDateString()}</span></div>
    ${a.text?`<div class="annotation-text" style="--hl:${colorMap[a.color]||colorMap.yellow}">${escapeHtml(a.text)}</div>`:''}
    ${a.note?`<div class="annotation-note">${escapeHtml(a.note)}</div>`:''}
    <div class="annotation-actions"><button class="button small-button secondary" data-edit-annotation="${escapeHtml(a.id)}">Edit</button><button class="button small-button secondary" data-delete-annotation="${escapeHtml(a.id)}">Delete</button></div>
  </article>`).join('');
  list.querySelectorAll('[data-edit-annotation]').forEach(b=>b.addEventListener('click',()=>openAnnotationForm(state.annotations.find(a=>a.id===b.dataset.editAnnotation))));
  list.querySelectorAll('[data-delete-annotation]').forEach(b=>b.addEventListener('click',()=>removeAnnotation(b.dataset.deleteAnnotation)));
}
function openAnnotationForm(a=null) {
  const f=$('#annotation-form');f.reset();$('#annotation-error').textContent='';
  $('#annotation-dialog-title').textContent=a?'Edit annotation':'Add annotation';
  f.elements.id.value=a?.id||'';f.elements.type.value=a?.type||'comment';f.elements.page.value=a?.page||1;
  f.elements.color.value=a?.color||'yellow';f.elements.text.value=a?.text||'';f.elements.note.value=a?.note||'';
  annotationDialog.showModal();
}
async function saveAnnotation(e) {
  e.preventDefault(); if(!state.current)return;
  const f=e.currentTarget,id=f.elements.id.value;
  const payload={type:f.elements.type.value,page:Number(f.elements.page.value),color:f.elements.color.value,text:f.elements.text.value,note:f.elements.note.value};
  try {
    await api(id?`/api/papers/${state.current.id}/annotations/${id}`:`/api/papers/${state.current.id}/annotations`,{method:id?'PATCH':'POST',body:JSON.stringify(payload)});
    annotationDialog.close();const {annotations}=await api(`/api/papers/${state.current.id}/annotations`);state.annotations=annotations;renderAnnotations();showNotice('Annotation saved to your account.');
  } catch(err){$('#annotation-error').textContent=err.message;}
}
async function removeAnnotation(id) {
  if(!confirm('Delete this annotation?'))return;
  try {await api(`/api/papers/${state.current.id}/annotations/${id}`,{method:'DELETE'});state.annotations=state.annotations.filter(a=>a.id!==id);renderAnnotations();showNotice('Annotation deleted.');}
  catch(err){showNotice(err.message,true);}
}
async function uploadPdf(e) {
  const file=e.target.files?.[0];e.target.value='';if(!file||!state.current)return;
  if(file.type!=='application/pdf'&&!file.name.toLowerCase().endsWith('.pdf')){showNotice('Choose a PDF file.',true);return;}
  const form=new FormData();form.append('pdf',file);
  try {await api(`/api/papers/${state.current.id}/pdf`,{method:'POST',body:form});await openDetails(state.current.id);await loadPapers();showNotice('PDF uploaded privately to MongoDB Atlas.');}
  catch(err){showNotice(err.message,true);}
}
async function uploadNewPdfFromLibrary(e) {
  const file=e.target.files?.[0];e.target.value='';if(!file)return;
  if(file.type!=='application/pdf'&&!file.name.toLowerCase().endsWith('.pdf')){showNotice('Choose a PDF file.',true);return;}
  const title=file.name.replace(/\.pdf$/i,'').replace(/[._]+/g,' ').trim() || file.name;
  showNotice(`Adding “${title}” and uploading PDF…`);
  try {
    const created=await api('/api/papers',{method:'POST',body:JSON.stringify({title,status:'to-read',tags:[]})});
    const form=new FormData();form.append('pdf',file);
    await api(`/api/papers/${created.paper.id}/pdf`,{method:'POST',body:form});
    await loadPapers();
    showNotice('PDF uploaded privately. Paper entry created from the filename. You can edit its metadata in the workspace.');
    await openDetails(created.paper.id);
  } catch(err) {
    await loadPapers().catch(()=>{});
    showNotice(`${err.message} If a paper entry was created before the upload failed, it will remain in your library without an attached PDF.`,true);
  }
}
async function openPaperPdf(id) {
  try {
    const response=await fetch(`/api/papers/${id}/pdf`,{headers:{Authorization:`Bearer ${state.token}`}});
    if(!response.ok){const b=await response.json().catch(()=>({}));throw new Error(b.error||'Could not open PDF.');}
    const blob=await response.blob();const url=URL.createObjectURL(blob);const w=window.open(url,'_blank','noopener');
    if(!w) {const a=document.createElement('a');a.href=url;a.download='paper.pdf';a.click();}
    setTimeout(()=>URL.revokeObjectURL(url),60000);
  } catch(err){showNotice(err.message,true);}
}
function openPdf(){if(state.current)openPaperPdf(state.current.id);}
async function deleteCurrent() {
  if(!state.current||!confirm(`Permanently delete “${state.current.title}”, its annotations and attached PDF?`))return;
  try {await api(`/api/papers/${state.current.id}`,{method:'DELETE'});detailDialog.close();state.current=null;await loadPapers();showNotice('Paper and its stored PDF were deleted.');}
  catch(err){$('#detail-error').textContent=err.message;}
}
initialise();
