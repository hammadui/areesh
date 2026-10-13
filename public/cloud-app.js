

(function(){
"use strict";
const $=(s,r=document)=>r.querySelector(s);
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const gid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,8);
const COLORS=[["yellow","Key point"],["green","Method"],["blue","Finding"],["pink","Critique"],["orange","Follow up"]];
const STATUSES=[["toread","To read"],["reading","Reading"],["read","Read"]];
const NOTE_FIELDS=[
  ["question","Aim / research question",""],
  ["design","Design & methods","Setting, sample, data, analysis"],
  ["findings","Key findings",""],
  ["appraisal","Quality appraisal","Strengths, limitations, risk of bias"],
  ["relevance","Relevance to my review","Which theme or chapter it feeds"],
  ["other","Other notes",""]
];
const ICON={
  search:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  plus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
  back:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>',
  cursor:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 3l14 8-6 2-2 6z"/></svg>',
  marker:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 4l5 5-9 9H6v-5z"/><path d="M4 21h16"/></svg>',
  note:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v11l-5 5H4z"/><path d="M15 20v-5h5"/></svg>',
  edit:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  panel:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>',
  download:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  open:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>',
  filter:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16l-6 8v6l-4-2v-4z"/></svg>',
  x:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18"/></svg>'
};

const S={
  mode:"loading",
  papers:new Map(), view:"library",
  filter:{q:"",status:"all",tag:null,key:false}, sort:"added",
  cur:null, tool:"select", color:"yellow", panelTab:"notes", panelOpen:window.innerWidth>860, annFilter:"all"
};

/* ---------------- storage ---------------- */
const lsGet=(k,d)=>{try{const v=localStorage.getItem(k);return v==null?d:JSON.parse(v)}catch(e){return d}};
const lsSet=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}};
S.sort=lsGet("mg.sort","added"); S.color=lsGet("mg.color","yellow");

let idb=null;
// Cloud-backed replacement for the original IndexedDB adapter. The reader UI and PDF.js tools remain the original ones.
let cloudToken = sessionStorage.getItem("marginalia_token") || "";
async function cloudRequest(url, options={}, responseType="json"){
  const headers=new Headers(options.headers||{});
  if(cloudToken) headers.set("Authorization",`Bearer ${cloudToken}`);
  if(options.body && !(options.body instanceof Blob) && !(options.body instanceof FormData) && !(options.body instanceof ArrayBuffer) && !headers.has("Content-Type")) headers.set("Content-Type","application/json");
  const res=await fetch(url,{...options,headers});
  if(!res.ok){
    let message=`Request failed (${res.status})`;
    try{const err=await res.clone().json(); if(err.error) message=err.error}catch{}
    if(res.status===401){cloudToken="";sessionStorage.removeItem("marginalia_token");}
    throw new Error(message);
  }
  if(res.status===204) return null;
  if(responseType==="blob") return await res.blob();
  return await res.json();
}
async function idbOpen(){return {cloud:true}}
const cloudPath=(st,k="")=>`/api/cloud-store/${encodeURIComponent(st)}${k!==""?`/${encodeURIComponent(k)}`:""}`;
const idbPut=async(st,k,v)=>{
  if(st==="files") return cloudRequest(cloudPath(st,k),{method:"PUT",headers:{"Content-Type":"application/octet-stream"},body:v},"json");
  return cloudRequest(cloudPath(st,k),{method:"PUT",body:JSON.stringify(v)},"json");
};
const idbGet=async(st,k)=>cloudRequest(cloudPath(st,k),{},st==="files"?"blob":"json");
const idbDel=async(st,k)=>cloudRequest(cloudPath(st,k),{method:"DELETE"},"json");
const idbKeys=async(st)=>(await cloudRequest(cloudPath(st,"keys"))).keys;
const idbAll=async(st)=>(await cloudRequest(cloudPath(st,"all"))).values;

const chains=new Map(); const timers=new Map(); let pending=0;
function setSave(t){$("#saveState").textContent=t}
function queueWrite(key,fn){
  if(S.mode!=="store") return Promise.resolve();
  pending++; setSave("Saving…");
  const prev=chains.get(key)||Promise.resolve();
  const p=prev.catch(()=>{}).then(fn).then(()=>{lsSet("mg.changed",Date.now())},e=>{toast(dbErr(e));throw e}).finally(()=>{pending--; setSave(pending?"Saving…":"All changes saved"); if(!pending) updateBackupNote()});
  chains.set(key,p); return p.catch(()=>{});
}
function dbErr(e){
  const n=e&&(e.name||e.code);
  if(n==="QuotaExceededError") return "Your browser has run out of storage space for this library. Back up, then delete papers you no longer need.";
  return "Couldn't save: "+((e&&e.message)||"unknown error");
}
function paperBody(p){const o={...p}; delete o._buf; delete o._busy; delete o._ann; return JSON.parse(JSON.stringify(o))}
function savePaperSoon(id,delay=700){
  if(S.mode!=="store") return;
  clearTimeout(timers.get("p"+id)); setSave("Saving…");
  timers.set("p"+id,setTimeout(()=>{const p=S.papers.get(id); if(p) queueWrite("p"+id,()=>idbPut("papers",id,paperBody(p)))},delay));
}
function saveAnnotsSoon(delay=500){
  const c=S.cur; if(!c) return;
  const p=S.papers.get(c.id);
  p.hlCount=c.ann.hl.length; p.stCount=c.ann.st.length; p.updated=Date.now();
  if(S.mode!=="store") return;
  const id=c.id, body=JSON.parse(JSON.stringify(c.ann));
  clearTimeout(timers.get("a"+id)); setSave("Saving…");
  timers.set("a"+id,setTimeout(()=>{queueWrite("a"+id,()=>idbPut("annots",id,body)); savePaperSoon(id,0)},delay));
}

/* ---------------- boot ---------------- */
async function boot(){
  try{
    idb=await idbOpen();
    const all=await idbAll("papers"); const keys=await idbKeys("papers");
    keys.forEach((k,i)=>S.papers.set(k,{...all[i],id:k}));
    S.mode="store";
    setSave(S.papers.size?"All changes saved":"");
    try{if(navigator.storage&&navigator.storage.persist) navigator.storage.persist()}catch(e){}
  }catch(e){
    S.mode="memory";
    $("#bannerSlot").innerHTML='<div class="banner">Could not load your cloud library. Check that the Node.js server is running and connected to MongoDB Atlas, then reload. Avoid adding or editing papers until the cloud connection is restored.</div>';
  }
  render();
}

/* ---------------- library ---------------- */
function citeKey(p){
  const a=(p.authors||"").split(/;|,| and /)[0].trim();
  const w=a?a.replace(/\./g," ").trim().split(/\s+/):[]; const lastW=w[w.length-1]||"";
  const sur=!w.length?"":(w.length>1&&/^[A-Z]{1,3}$/.test(lastW))?w[0]:lastW;
  return (sur||"Untitled")+(p.year?p.year:"");
}
function tagCounts(){const m=new Map(); for(const p of S.papers.values())(p.tags||[]).forEach(t=>m.set(t,(m.get(t)||0)+1)); return [...m.entries()].sort((a,b)=>a[0].localeCompare(b[0]))}
function filtered(){
  const q=S.filter.q.trim().toLowerCase();
  let arr=[...S.papers.values()].filter(p=>{
    if(S.filter.status!=="all"&&p.status!==S.filter.status) return false;
    if(S.filter.key&&!p.key) return false;
    if(S.filter.tag&&!(p.tags||[]).includes(S.filter.tag)) return false;
    if(q){const hay=[p.title,p.authors,p.venue,p.year,p.doi,(p.tags||[]).join(" "),...Object.values(p.notes||{})].join(" ").toLowerCase(); if(!hay.includes(q)) return false}
    return true;
  });
  const by={added:(a,b)=>(b.added||0)-(a.added||0),opened:(a,b)=>(b.opened||0)-(a.opened||0),year:(a,b)=>(b.year||0)-(a.year||0),title:(a,b)=>(a.title||"").localeCompare(b.title||""),author:(a,b)=>citeKey(a).localeCompare(citeKey(b))};
  return arr.sort(by[S.sort]||by.added);
}
function renderLibrary(){
  const view=$("#view");
  const all=[...S.papers.values()];
  const cnt=s=>all.filter(p=>p.status===s).length;
  const tags=tagCounts();
  const list=filtered();
  const statusBtns=[["all","All papers",all.length],...STATUSES.map(([k,l])=>[k,l,cnt(k)])].map(([k,l,n])=>`<button data-status="${k}" class="${S.filter.status===k&&!S.filter.key?"on":""}"><span>${l}</span><span class="n">${n}</span></button>`).join("")
    +`<button data-keyf="1" class="${S.filter.key?"on":""}"><span><span class="star">★</span> Key papers</span><span class="n">${all.filter(p=>p.key).length}</span></button>`;
  const tagBtns=tags.length?tags.map(([t,n])=>`<button data-tag="${esc(t)}" class="${S.filter.tag===t?"on":""}"><span>${esc(t)}</span><span class="n">${n}</span></button>`).join(""):`<div class="empty">Add tags to a paper to group it by theme.</div>`;
  let body;
  if(!all.length){
    body=`<div class="empty-state">
      <h2>Build your reading library</h2>
      <p>Add the PDFs for your literature review. Each paper opens in a reader where you can highlight passages, pin sticky notes to the page and fill in structured review notes. Everything is saved in this browser on this computer; use Back up now and then to keep a copy safe.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" data-act="add">${ICON.plus} Add PDFs</button><span class="muted" style="align-self:center;font-size:13px">or drop files anywhere on this page</span></div>
      <ul>
        <li><span class="sw" style="background:var(--hl-yellow)"></span><span><b>Highlight in five colours.</b> Key point, method, finding, critique and follow up, each with an optional comment.</span></li>
        <li><span class="sw" style="background:var(--hl-orange)"></span><span><b>Sticky notes.</b> Pin a note anywhere on a page and drag it where you need it.</span></li>
        <li><span class="sw" style="background:var(--hl-blue)"></span><span><b>Review notes.</b> Aim, methods, findings, appraisal and relevance for every paper, searchable from the library and exportable as Markdown.</span></li>
      </ul></div>`;
  }else{
    const rows=list.map(p=>{
      const st=STATUSES.find(s=>s[0]===p.status)||STATUSES[0];
      const meta=[p.authors,p.year,p.venue].filter(Boolean).map(esc).join(" · ")||'<span class="muted">Add authors, year and journal</span>';
      return `<div class="row${p._busy?" busy":""}" data-open="${p.id}" tabindex="0">
        <div style="min-width:0"><div class="t">${p.key?'<span class="star" title="Key paper">★</span> ':""}${esc(p.title)}<span class="key">${esc(citeKey(p))}</span></div>
        <div class="meta">${p._busy?esc(p._busy):meta}</div>
        ${(p.tags||[]).length?`<div class="tags">${p.tags.map(t=>`<span class="tag">${esc(t)}</span>`).join("")}</div>`:""}</div>
        <div class="side"><span class="pill ${st[0]}">${st[1]}</span>
        <div class="counts"><span title="Highlights"><i style="background:var(--hl-yellow)"></i>${p.hlCount||0}</span><span title="Sticky notes"><i style="background:var(--hl-orange)"></i>${p.stCount||0}</span>${p.pages?`<span>${p.pages} pp</span>`:""}</div>
        <button class="btn ghost" data-edit="${p.id}" title="Edit details" style="padding:3px 6px">${ICON.edit}</button></div></div>`;
    }).join("");
    const title=S.filter.key?"Key papers":S.filter.tag?S.filter.tag:S.filter.status==="all"?"All papers":STATUSES.find(s=>s[0]===S.filter.status)[1];
    body=`<div class="listhead"><button class="btn filters-btn" data-act="rail">${ICON.filter} Filters</button><h2>${esc(title)}</h2><span class="count">${list.length} of ${all.length}</span><div class="spacer"></div>
      <label class="muted" for="sortSel" style="font-size:12px">Sort</label>
      <select id="sortSel" class="input" style="padding:4px 8px">${[["added","Recently added"],["opened","Recently opened"],["author","First author"],["year","Year (newest)"],["title","Title"]].map(([k,l])=>`<option value="${k}"${S.sort===k?" selected":""}>${l}</option>`).join("")}</select></div>
      ${list.length?`<div class="rows">${rows}</div>`:`<p class="muted" style="padding:20px 0">No papers match. Clear the search or pick another filter.</p>`}`;
  }
  view.innerHTML=`<div class="bar" style="border-top:0;padding-top:8px;padding-bottom:8px">
      <div class="search">${ICON.search}<input id="q" class="input" type="search" placeholder="Search titles, authors, tags and notes" value="${esc(S.filter.q)}"></div>
      <div class="spacer"></div>
      <span class="save-state" id="backupNote"></span>
      ${all.length?`<button class="btn" data-act="backup" title="Save every paper, note and highlight to one file">${ICON.download} Back up</button>`:""}
      <button class="btn ghost" data-act="restore" title="Load papers from a backup file">Restore</button>
      ${all.length?`<button class="btn ghost" data-act="exportall">Export notes</button>`:""}
      <button class="btn primary" data-act="add">${ICON.plus} Add PDFs</button></div>
    <div class="lib" id="lib"><aside class="rail"><div><h3>Reading status</h3><div class="facet">${statusBtns}</div></div><div><h3>Tags</h3><div class="facet">${tagBtns}</div></div></aside>
    <section class="main" id="main">${body}</section></div>`;
  const q=$("#q"); q.addEventListener("input",()=>{S.filter.q=q.value; const pos=q.selectionStart; renderLibrary(); const q2=$("#q"); q2.focus(); q2.setSelectionRange(pos,pos)});
  updateBackupNote();
  const ss=$("#sortSel"); if(ss) ss.onchange=()=>{S.sort=ss.value; lsSet("mg.sort",S.sort); renderLibrary()};
}
document.addEventListener("click",e=>{
  if(S.view!=="library") return;
  const t=e.target.closest("[data-act],[data-status],[data-tag],[data-keyf],[data-edit],[data-open]"); if(!t) return;
  if(t.dataset.act==="add"){$("#fileIn").click();return}
  if(t.dataset.act==="exportall"){exportAll();return}
  if(t.dataset.act==="backup"){backupLibrary();return}
  if(t.dataset.act==="restore"){$("#restoreIn").click();return}
  if(t.dataset.act==="rail"){$("#lib").classList.toggle("show-rail");return}
  if(t.dataset.status){S.filter.status=t.dataset.status; S.filter.key=false; S.filter.tag=null; renderLibrary();return}
  if(t.dataset.keyf){S.filter.key=!S.filter.key; S.filter.status="all"; S.filter.tag=null; renderLibrary();return}
  if(t.dataset.tag!=null&&t.dataset.tag!==""){S.filter.tag=S.filter.tag===t.dataset.tag?null:t.dataset.tag; renderLibrary();return}
  if(t.dataset.edit){e.stopPropagation(); editPaper(t.dataset.edit);return}
  if(t.dataset.open){const p=S.papers.get(t.dataset.open); if(p&&!p._busy) openPaper(p.id)}
});
document.addEventListener("keydown",e=>{if(S.view==="library"&&e.key==="Enter"&&e.target.dataset&&e.target.dataset.open) openPaper(e.target.dataset.open)});

/* ---------------- adding papers ---------------- */
$("#fileIn").addEventListener("change",e=>{addFiles([...e.target.files]); e.target.value=""});
let dragDepth=0;
window.addEventListener("dragenter",e=>{if(S.view!=="library"||!e.dataTransfer||![...e.dataTransfer.types].includes("Files"))return; e.preventDefault(); dragDepth++; const m=$("#main"); if(m&&!$(".drop",m)){const d=document.createElement("div");d.className="drop";d.textContent="Drop PDFs to add them to your library";m.appendChild(d)}});
window.addEventListener("dragover",e=>{if(S.view==="library")e.preventDefault()});
window.addEventListener("dragleave",()=>{if(--dragDepth<=0){dragDepth=0;const d=$(".drop");if(d)d.remove()}});
window.addEventListener("drop",e=>{if(S.view!=="library")return; e.preventDefault(); dragDepth=0; const d=$(".drop"); if(d)d.remove(); addFiles([...e.dataTransfer.files])});

function cleanName(n){return n.replace(/\.pdf$/i,"").replace(/[_]+/g," ").replace(/\s+/g," ").trim()}
async function addFiles(files){
  files=files.filter(f=>f.type==="application/pdf"||/\.pdf$/i.test(f.name));
  if(!files.length){toast("Only PDF files can be added.");return}
  for(const f of files){
        const dup=[...S.papers.values()].find(p=>p.fileName===f.name&&p.size===f.size);
    if(dup){toast(`${f.name} is already in your library.`);continue}
    const id=gid();
    const p={id,title:cleanName(f.name),authors:"",year:"",venue:"",doi:"",tags:[],status:"toread",key:false,notes:{},fileName:f.name,size:f.size,pages:0,hlCount:0,stCount:0,added:Date.now(),opened:0,updated:Date.now(),asset:null,_busy:"Reading PDF…"};
    S.papers.set(id,p); if(S.view==="library") renderLibrary();
    try{
      const buf=await f.arrayBuffer();
      try{
        const pdf=await pdfjsLib.getDocument({data:new Uint8Array(buf.slice(0)),isEvalSupported:false}).promise;
        p.pages=pdf.numPages;
        const md=await pdf.getMetadata().catch(()=>null);
        const info=md&&md.info||{};
        if(info.Title&&info.Title.trim().length>8&&!/^(untitled|microsoft word|doi|\d)/i.test(info.Title.trim())) p.title=info.Title.trim();
        if(info.Author&&info.Author.trim()) p.authors=info.Author.trim();
        const dm=/D:(\d{4})/.exec(info.CreationDate||""); if(dm) p.year=dm[1];
        pdf.destroy();
      }catch(e){}
      if(S.mode==="store"){
        p._busy="Saving…"; if(S.view==="library") renderLibrary();
        await idbPut("files",id,new Blob([buf],{type:"application/pdf"}));
        p.asset=id;
        delete p._busy;
        await queueWrite("p"+id,()=>idbPut("papers",id,paperBody(p)));
      }else{p._buf=buf; delete p._busy}
    }catch(e){S.papers.delete(id); toast(`${f.name}: ${dbErr(e)}`)}
    if(S.view==="library") renderLibrary();
  }
}

/* ---------------- edit details modal ---------------- */
function editPaper(id){
  const p=S.papers.get(id); if(!p) return;
  const sc=document.createElement("div"); sc.className="scrim";
  sc.innerHTML=`<form class="modal" id="editForm"><h3>Paper details</h3>
   <div class="grid">
    <div class="f full"><label for="e_title">Title</label><input id="e_title" class="input" value="${esc(p.title)}" required></div>
    <div class="f full"><label for="e_auth">Authors</label><input id="e_auth" class="input" value="${esc(p.authors)}" placeholder="Surname A; Surname B"></div>
    <div class="f"><label for="e_year">Year</label><input id="e_year" class="input" value="${esc(p.year)}" inputmode="numeric"></div>
    <div class="f"><label for="e_venue">Journal or source</label><input id="e_venue" class="input" value="${esc(p.venue)}"></div>
    <div class="f full"><label for="e_doi">DOI or link</label><input id="e_doi" class="input" value="${esc(p.doi)}" placeholder="10.1016/…"></div>
    <div class="f full"><label for="e_tags">Tags (comma separated)</label><input id="e_tags" class="input" value="${esc((p.tags||[]).join(", "))}" list="tagList"><datalist id="tagList">${tagCounts().map(([t])=>`<option value="${esc(t)}">`).join("")}</datalist></div>
    <div class="f"><label for="e_status">Status</label><select id="e_status" class="input">${STATUSES.map(([k,l])=>`<option value="${k}"${p.status===k?" selected":""}>${l}</option>`).join("")}</select></div>
    <div class="f" style="justify-content:flex-end"><label style="display:flex;gap:8px;align-items:center;color:var(--ink);font-size:13px"><input type="checkbox" id="e_key"${p.key?" checked":""}> Key paper</label></div>
   </div>
   <div class="foot"><button type="button" class="btn danger" id="e_del">Delete paper</button><div class="spacer"></div><button type="button" class="btn" id="e_cancel">Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`;
  document.body.appendChild(sc);
  const close=()=>sc.remove();
  sc.addEventListener("click",e=>{if(e.target===sc)close()});
  $("#e_cancel",sc).onclick=close;
  let armed=false;
  $("#e_del",sc).onclick=async ev=>{
    const b=ev.currentTarget;
    if(!armed){armed=true;b.classList.add("armed");b.textContent="Delete paper and all its notes";setTimeout(()=>{if(b.isConnected){armed=false;b.classList.remove("armed");b.textContent="Delete paper"}},4000);return}
    close(); await deletePaper(id);
  };
  $("#editForm",sc).onsubmit=e=>{
    e.preventDefault();
    p.title=$("#e_title",sc).value.trim()||p.title; p.authors=$("#e_auth",sc).value.trim(); p.year=$("#e_year",sc).value.trim();
    p.venue=$("#e_venue",sc).value.trim(); p.doi=$("#e_doi",sc).value.trim();
    p.tags=[...new Set($("#e_tags",sc).value.split(",").map(s=>s.trim()).filter(Boolean))];
    p.status=$("#e_status",sc).value; p.key=$("#e_key",sc).checked; p.updated=Date.now();
    savePaperSoon(id,0); close(); render();
  };
  setTimeout(()=>$("#e_title",sc).focus(),0);
  sc.addEventListener("keydown",e=>{if(e.key==="Escape")close()});
}
async function deletePaper(id){
  const p=S.papers.get(id); if(!p) return;
  S.papers.delete(id);
  if(S.cur&&S.cur.id===id) closeReader();
  render();
  if(S.mode==="store"){
    await queueWrite("p"+id,()=>idbDel("papers",id));
    await queueWrite("a"+id,()=>idbDel("annots",id));
    if(p.asset) await queueWrite("f"+id,()=>idbDel("files",p.asset));
  }
  toast("Paper deleted.");
}

/* ---------------- reader ---------------- */
async function openPaper(id){
  const p=S.papers.get(id); if(!p) return;
  S.view="reader";
  S.cur={id,pdf:null,ann:{hl:[],st:[]},scale:1,dims:[],rendered:new Map(),openSticky:null,io:null};
  p.opened=Date.now(); if(p.status==="toread"){p.status="reading"} savePaperSoon(id,1500);
  render();
  const c=S.cur;
  try{
    if(S.mode==="store"){
      const d=await idbGet("annots",id).catch(()=>null);
      if(d) c.ann={hl:d.hl||[],st:d.st||[]};
    }else if(p._ann){c.ann=p._ann}
    if(S.mode!=="store") p._ann=c.ann;
    renderPanel();
    let data;
    if(S.mode==="store"){
      if(!p.asset) throw new Error("This paper's PDF is missing.");
      const blob=await idbGet("files",p.asset); if(!blob) throw new Error("The PDF file for this paper is missing from this browser. Restore it from a backup or add it again.");
      data=new Uint8Array(await blob.arrayBuffer());
    }else data=new Uint8Array(p._buf.slice(0));
    if(S.cur!==c) return;
    c.pdf=await pdfjsLib.getDocument({data,isEvalSupported:false}).promise;
    if(S.cur!==c){c.pdf.destroy();return}
    if(!p.pages){p.pages=c.pdf.numPages; savePaperSoon(id)}
    const p1=await c.pdf.getPage(1); const vp=p1.getViewport({scale:1});
    for(let i=1;i<=c.pdf.numPages;i++) c.dims[i]={w:vp.width,h:vp.height};
    const vw=$("#viewer").clientWidth-40;
    c.scale=Math.max(.6,Math.min(1.8,vw/vp.width));
    layoutPages();
  }catch(e){$("#pages").innerHTML=`<div class="reader-msg">${esc(e.message||"Couldn't open this PDF.")}</div>`}
}
function closeReader(){
  const c=S.cur; if(c){if(c.io)c.io.disconnect(); if(c.pdf)c.pdf.destroy()}
  hideSelMenu(); hidePop();
  S.cur=null; S.view="library"; render();
}
function renderReader(){
  const p=S.papers.get(S.cur.id);
  $("#view").innerHTML=`<div class="rbar">
    <button class="btn ghost" id="backBtn" title="Back to library">${ICON.back} Library</button>
    <div class="rtitle" title="${esc(p.title)}">${esc(p.title)}</div>
    <div class="tools" role="group" aria-label="Tools">
      <button class="tool" data-tool="select" title="Select text (V)">${ICON.cursor}<span class="lbl">Select</span></button>
      <button class="tool" data-tool="highlight" title="Highlight as you select (H)">${ICON.marker}<span class="lbl">Highlight</span></button>
      <button class="tool" data-tool="note" title="Click the page to add a sticky note (N)">${ICON.note}<span class="lbl">Sticky</span></button>
    </div>
    <div class="swatches" id="swatches">${COLORS.map(([c,l])=>`<button class="sw" data-color="${c}" title="${l}" aria-label="${l}" style="background:var(--hl-${c})"></button>`).join("")}</div>
    <div class="zoom"><button class="btn ghost" data-zoom="-" aria-label="Zoom out">−</button><span id="zoomPct">100%</span><button class="btn ghost" data-zoom="+" aria-label="Zoom in">+</button><button class="btn ghost" data-zoom="fit">Fit</button></div>
    <span class="pageno" id="pageNo"></span>
    <button class="btn ghost" id="panelBtn" title="Show or hide notes">${ICON.panel}<span class="lbl">Notes</span></button>
  </div>
  <div class="reader${S.panelOpen?"":" panel-hidden"}" id="reader">
    <div class="stage"><div class="viewer" id="viewer"><div class="pages" id="pages"><div class="reader-msg">Opening PDF…</div></div></div></div>
    <aside class="panel" id="panel"></aside>
  </div>`;
  $("#backBtn").onclick=closeReader;
  $("#panelBtn").onclick=()=>{S.panelOpen=!S.panelOpen; $("#reader").classList.toggle("panel-hidden",!S.panelOpen)};
  $(".rbar").addEventListener("click",e=>{
    const t=e.target.closest("[data-tool],[data-color],[data-zoom]"); if(!t) return;
    if(t.dataset.tool) setTool(t.dataset.tool);
    if(t.dataset.color){S.color=t.dataset.color; lsSet("mg.color",S.color); syncTools(); if(S.tool==="select") setTool("highlight")}
    if(t.dataset.zoom) zoom(t.dataset.zoom);
  });
  const v=$("#viewer");
  v.addEventListener("scroll",()=>{hideSelMenu(); hidePop(); updatePageNo()},{passive:true});
  v.addEventListener("pointerup",onPointerUp);
  v.addEventListener("click",onViewerClick);
  syncTools(); renderPanel();
}
function setTool(t){S.tool=t; syncTools(); hideSelMenu()}
function syncTools(){
  document.querySelectorAll("[data-tool]").forEach(b=>b.classList.toggle("on",b.dataset.tool===S.tool));
  document.querySelectorAll("#swatches [data-color]").forEach(b=>b.classList.toggle("on",b.dataset.color===S.color));
  const v=$("#viewer"); if(v){v.classList.toggle("tool-note",S.tool==="note"); v.classList.toggle("tool-highlight",S.tool==="highlight")}
}
function zoom(d){
  const c=S.cur; if(!c||!c.pdf) return;
  const v=$("#viewer"); const rel=v.scrollTop/(v.scrollHeight||1);
  if(d==="+") c.scale=Math.min(3,c.scale*1.15);
  else if(d==="-") c.scale=Math.max(.4,c.scale/1.15);
  else c.scale=Math.max(.4,Math.min(3,(v.clientWidth-40)/c.dims[1].w));
  layoutPages(); v.scrollTop=rel*v.scrollHeight;
}
function layoutPages(){
  const c=S.cur; const pages=$("#pages"); if(!pages) return;
  if(c.io) c.io.disconnect();
  c.rendered.forEach(t=>{try{t&&t.cancel&&t.cancel()}catch(e){}}); c.rendered=new Map();
  $("#zoomPct").textContent=Math.round(c.scale*100)+"%";
  let h="";
  for(let i=1;i<=c.pdf.numPages;i++){const d=c.dims[i]; h+=`<div class="page" data-page="${i}" style="width:${Math.floor(d.w*c.scale)}px;height:${Math.floor(d.h*c.scale)}px"><div class="loading">Page ${i}</div><span class="pnum">${i}</span></div>`}
  pages.innerHTML=h;
  c.io=new IntersectionObserver(ents=>ents.forEach(en=>{if(en.isIntersecting) renderPage(+en.target.dataset.page)}),{root:$("#viewer"),rootMargin:"800px 0px"});
  pages.querySelectorAll(".page").forEach(el=>c.io.observe(el));
  updatePageNo();
}
async function renderPage(i){
  const c=S.cur; if(!c||c.rendered.has(i)) return;
  c.rendered.set(i,null);
  const scale=c.scale;
  const page=await c.pdf.getPage(i);
  if(S.cur!==c||c.scale!==scale) return;
  const vp=page.getViewport({scale});
  const base=page.getViewport({scale:1}); c.dims[i]={w:base.width,h:base.height};
  const el=$(`#pages .page[data-page="${i}"]`); if(!el) return;
  el.style.width=Math.floor(vp.width)+"px"; el.style.height=Math.floor(vp.height)+"px";
  const dpr=Math.min(window.devicePixelRatio||1,2);
  const cv=document.createElement("canvas"); cv.width=Math.floor(vp.width*dpr); cv.height=Math.floor(vp.height*dpr);
  const task=page.render({canvasContext:cv.getContext("2d"),viewport:vp,transform:dpr!==1?[dpr,0,0,dpr,0,0]:null});
  c.rendered.set(i,task);
  try{await task.promise}catch(e){return}
  if(S.cur!==c||c.scale!==scale) return;
  el.innerHTML=`<span class="pnum">${i}</span>`;
  el.appendChild(cv);
  const tl=document.createElement("div"); tl.className="textLayer"; tl.style.setProperty("--scale-factor",scale); el.appendChild(tl);
  const hl=document.createElement("div"); hl.className="hl-layer"; el.appendChild(hl);
  const st=document.createElement("div"); st.className="st-layer"; el.appendChild(st);
  drawAnnots(i);
  try{const tc=await page.getTextContent(); await pdfjsLib.renderTextLayer({textContentSource:tc,container:tl,viewport:vp,textDivs:[]}).promise; const eoc=document.createElement("div"); eoc.className="endOfContent"; tl.appendChild(eoc)}catch(e){}
}
function updatePageNo(){
  const c=S.cur, v=$("#viewer"); if(!c||!c.pdf||!v) return;
  const mid=v.scrollTop+v.clientHeight/3; let cur=1;
  v.querySelectorAll(".page").forEach(el=>{if(el.offsetTop<=mid) cur=+el.dataset.page});
  $("#pageNo").textContent=`p. ${cur} / ${c.pdf.numPages}`;
}

/* ---- annotations drawing ---- */
function drawAnnots(i){
  const c=S.cur; const el=$(`#pages .page[data-page="${i}"]`); if(!el) return;
  const hlL=$(".hl-layer",el), stL=$(".st-layer",el); if(!hlL) return;
  hlL.innerHTML=c.ann.hl.filter(h=>h.page===i).map(h=>h.rects.map(([x,y,w,hh])=>`<div class="hl-rect${h.comment?" has-c":""}" data-hl="${h.id}" style="left:${x*100}%;top:${y*100}%;width:${w*100}%;height:${hh*100}%;background:var(--hl-${h.color})"></div>`).join("")).join("");
  stL.innerHTML="";
  c.ann.st.filter(s=>s.page===i).forEach(s=>stL.appendChild(stickyEl(s)));
}
function stickyEl(s){
  const d=document.createElement("div"); d.className="sticky"; d.dataset.st=s.id;
  d.style.left=s.x*100+"%"; d.style.top=s.y*100+"%";
  d.innerHTML=`<button class="ico" style="background:var(--hl-${s.color})" aria-label="Sticky note">${ICON.note}</button>`;
  if(S.cur.openSticky===s.id) d.appendChild(stickyCard(s));
  const ico=$(".ico",d);
  ico.addEventListener("pointerdown",ev=>{
    ev.preventDefault(); ev.stopPropagation();
    const pageEl=d.closest(".page"); const r=pageEl.getBoundingClientRect();
    const sx=ev.clientX, sy=ev.clientY; let moved=false;
    ico.setPointerCapture(ev.pointerId);
    const mv=e2=>{if(!moved&&Math.hypot(e2.clientX-sx,e2.clientY-sy)<4)return; moved=true;
      s.x=Math.max(0,Math.min(.97,(e2.clientX-r.left)/r.width)); s.y=Math.max(0,Math.min(.97,(e2.clientY-r.top)/r.height));
      d.style.left=s.x*100+"%"; d.style.top=s.y*100+"%"};
    const up=()=>{ico.removeEventListener("pointermove",mv); ico.removeEventListener("pointerup",up); ico.removeEventListener("pointercancel",up);
      if(moved){saveAnnotsSoon(); renderPanel()} else toggleSticky(s.id)};
    ico.addEventListener("pointermove",mv); ico.addEventListener("pointerup",up); ico.addEventListener("pointercancel",up);
  });
  d.addEventListener("click",e=>e.stopPropagation());
  return d;
}
function stickyCard(s){
  const card=document.createElement("div"); card.className="card";
  card.innerHTML=`<div class="ch"><span>Sticky · p. ${s.page}</span><div class="spacer"></div><button class="btn ghost" data-x style="padding:2px 4px" aria-label="Close">${ICON.x}</button></div>
   <textarea id="st_${s.id}" placeholder="Write a note…">${esc(s.text)}</textarea>
   <div class="cf">${COLORS.map(([c,l])=>`<button class="sw${s.color===c?" on":""}" data-c="${c}" title="${l}" aria-label="${l}" style="background:var(--hl-${c})"></button>`).join("")}<div class="spacer"></div><button class="btn danger" data-del style="padding:3px 8px;font-size:12px">Delete</button></div>`;
  const ta=$("textarea",card);
  ta.addEventListener("input",()=>{s.text=ta.value; saveAnnotsSoon(900); renderPanelSoon()});
  card.addEventListener("pointerdown",e=>e.stopPropagation());
  $("[data-x]",card).onclick=()=>toggleSticky(s.id);
  $("[data-del]",card).onclick=()=>{S.cur.ann.st=S.cur.ann.st.filter(x=>x.id!==s.id); S.cur.openSticky=null; drawAnnots(s.page); saveAnnotsSoon(); renderPanel()};
  card.querySelectorAll("[data-c]").forEach(b=>b.onclick=()=>{s.color=b.dataset.c; drawAnnots(s.page); saveAnnotsSoon(); renderPanel()});
  setTimeout(()=>{if(ta.isConnected&&!s.text) ta.focus()},0);
  return card;
}
function toggleSticky(id){
  const c=S.cur; const prev=c.openSticky; c.openSticky=prev===id?null:id;
  const pg=new Set([prev,id].map(x=>{const s=c.ann.st.find(y=>y.id===x);return s&&s.page}).filter(Boolean));
  pg.forEach(drawAnnots);
}
function onViewerClick(e){
  const c=S.cur; if(!c) return;
  const hl=e.target.closest("[data-hl]");
  if(hl&&S.tool!=="note"){openHlPop(hl.dataset.hl,e.clientX,e.clientY);return}
  const pageEl=e.target.closest(".page");
  if(S.tool==="note"&&pageEl&&!e.target.closest(".sticky")){
    const r=pageEl.getBoundingClientRect();
    const s={id:gid(),page:+pageEl.dataset.page,x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height,text:"",color:S.color==="yellow"?"orange":S.color,at:Date.now()};
    c.ann.st.push(s); c.openSticky=s.id; drawAnnots(s.page); saveAnnotsSoon(); renderPanel();
    return;
  }
  if(c.openSticky&&!e.target.closest(".sticky")){toggleSticky(c.openSticky)}
}

/* ---- selection → highlight ---- */
function selectionInfo(){
  const sel=getSelection(); if(!sel||sel.rangeCount===0||sel.isCollapsed) return null;
  const range=sel.getRangeAt(0);
  const pagesEl=$("#pages"); if(!pagesEl||!pagesEl.contains(range.commonAncestorContainer)) return null;
  const text=sel.toString().replace(/\s+/g," ").trim(); if(!text) return null;
  const pageEls=[...pagesEl.querySelectorAll(".page")].map(el=>({el,r:el.getBoundingClientRect(),n:+el.dataset.page}));
  const groups=new Map();
  for(const r of range.getClientRects()){
    if(r.width<1||r.height<2) continue;
    const cx=r.left+r.width/2, cy=r.top+r.height/2;
    const pg=pageEls.find(p=>cx>=p.r.left&&cx<=p.r.right&&cy>=p.r.top&&cy<=p.r.bottom); if(!pg) continue;
    const arr=groups.get(pg.n)||[]; arr.push([(r.left-pg.r.left)/pg.r.width,(r.top-pg.r.top)/pg.r.height,r.width/pg.r.width,r.height/pg.r.height]); groups.set(pg.n,arr);
  }
  if(!groups.size) return null;
  for(const [k,arr] of groups) groups.set(k,mergeRects(arr));
  const last=range.getBoundingClientRect();
  return {text,groups,x:last.left+last.width/2,y:last.top};
}
function mergeRects(arr){
  arr.sort((a,b)=>a[1]-b[1]||a[0]-b[0]); const out=[];
  for(const r of arr){
    const l=out[out.length-1];
    if(l&&Math.abs((l[1]+l[3]/2)-(r[1]+r[3]/2))<Math.min(l[3],r[3])*.6&&r[0]<=l[0]+l[2]+.012){
      const x1=Math.min(l[0],r[0]),y1=Math.min(l[1],r[1]),x2=Math.max(l[0]+l[2],r[0]+r[2]),y2=Math.max(l[1]+l[3],r[1]+r[3]); l[0]=x1;l[1]=y1;l[2]=x2-x1;l[3]=y2-y1;
    }else out.push([...r]);
  }
  return out.map(r=>r.map(v=>Math.round(v*10000)/10000));
}
function addHighlight(info,color,openComment){
  const c=S.cur; const made=[];
  for(const [page,rects] of info.groups){const h={id:gid(),page,rects,text:info.text,color,comment:"",at:Date.now()}; c.ann.hl.push(h); made.push(h); drawAnnots(page)}
  getSelection().removeAllRanges(); hideSelMenu(); saveAnnotsSoon(); renderPanel();
  if(openComment&&made[0]) openHlPop(made[0].id,info.x,info.y+24,true);
}
function onPointerUp(e){
  if(S.tool==="note"||e.target.closest(".sticky,.card")) return;
  setTimeout(()=>{
    const info=selectionInfo(); if(!info){hideSelMenu();return}
    if(S.tool==="highlight"){addHighlight(info,S.color,false);return}
    showSelMenu(info);
  },10);
}
let selMenu=null;
function showSelMenu(info){
  hideSelMenu(); hidePop();
  selMenu=document.createElement("div"); selMenu.className="selmenu";
  selMenu.innerHTML=COLORS.map(([c,l])=>`<button class="sw" data-c="${c}" title="Highlight: ${l}" aria-label="Highlight ${l}" style="background:var(--hl-${c})"></button>`).join("")+`<span class="div"></span><button class="txt" data-cm>Comment</button><button class="txt" data-cp>Copy</button>`;
  document.body.appendChild(selMenu);
  const w=selMenu.offsetWidth; selMenu.style.left=Math.max(8,Math.min(innerWidth-w-8,info.x-w/2))+"px"; selMenu.style.top=Math.max(8,info.y-46)+"px";
  selMenu.addEventListener("pointerdown",e=>e.preventDefault());
  selMenu.querySelectorAll("[data-c]").forEach(b=>b.onclick=()=>addHighlight(info,b.dataset.c,false));
  $("[data-cm]",selMenu).onclick=()=>addHighlight(info,S.color,true);
  $("[data-cp]",selMenu).onclick=()=>{copyText(info.text).then(ok=>toast(ok?"Copied passage.":"Couldn't copy. Select the text and copy it manually.")); hideSelMenu()};
}
function hideSelMenu(){if(selMenu){selMenu.remove();selMenu=null}}
let pop=null;
function openHlPop(id,x,y,focus){
  hidePop(); hideSelMenu();
  const c=S.cur; const h=c.ann.hl.find(z=>z.id===id); if(!h) return;
  pop=document.createElement("div"); pop.className="pop";
  pop.innerHTML=`<div class="q">${esc(h.text)}</div>
   <textarea id="hlc_${h.id}" placeholder="Add a comment…">${esc(h.comment)}</textarea>
   <div class="r">${COLORS.map(([cc,l])=>`<button class="sw${h.color===cc?" on":""}" data-c="${cc}" title="${l}" aria-label="${l}" style="background:var(--hl-${cc})"></button>`).join("")}<div class="spacer"></div>
   <button class="btn ghost" data-cp style="padding:3px 7px;font-size:12px">Copy</button><button class="btn danger" data-del style="padding:3px 7px;font-size:12px">Delete</button></div>`;
  document.body.appendChild(pop);
  const w=pop.offsetWidth,hh=pop.offsetHeight;
  pop.style.left=Math.max(8,Math.min(innerWidth-w-8,x-w/2))+"px";
  pop.style.top=(y+12+hh>innerHeight?Math.max(8,y-hh-12):y+12)+"px";
  const ta=$("textarea",pop);
  ta.addEventListener("input",()=>{h.comment=ta.value; saveAnnotsSoon(900); renderPanelSoon()});
  ta.addEventListener("blur",()=>drawAnnots(h.page));
  pop.querySelectorAll("[data-c]").forEach(b=>b.onclick=()=>{h.color=b.dataset.c; pop.querySelectorAll("[data-c]").forEach(z=>z.classList.toggle("on",z===b)); drawAnnots(h.page); saveAnnotsSoon(); renderPanel()});
  $("[data-cp]",pop).onclick=()=>copyText(`"${h.text}" (${citeKey(S.papers.get(c.id))}, p. ${h.page})`).then(ok=>toast(ok?"Copied quote with citation.":"Couldn't copy."));
  $("[data-del]",pop).onclick=()=>{c.ann.hl=c.ann.hl.filter(z=>z.id!==h.id); drawAnnots(h.page); hidePop(); saveAnnotsSoon(); renderPanel()};
  pop.addEventListener("click",e=>e.stopPropagation());
  if(focus) setTimeout(()=>ta.focus(),0);
}
function hidePop(){if(pop){const id=pop.querySelector("textarea").id.slice(4); pop.remove(); pop=null; const h=S.cur&&S.cur.ann.hl.find(z=>z.id===id); if(h) drawAnnots(h.page)}}
document.addEventListener("pointerdown",e=>{
  if(pop&&!pop.contains(e.target)&&!e.target.closest("[data-hl]")) hidePop();
});
document.addEventListener("keydown",e=>{
  if(S.view!=="reader") return;
  if(e.key==="Escape"){hideSelMenu();hidePop();if(S.cur&&S.cur.openSticky)toggleSticky(S.cur.openSticky);return}
  if(/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  const k=e.key.toLowerCase();
  if(k==="v") setTool("select"); else if(k==="h") setTool("highlight"); else if(k==="n") setTool("note");
  else if(k==="+"||k==="=") zoom("+"); else if(k==="-") zoom("-");
});

/* ---- jump to annotation ---- */
function jumpTo(page,y,sel){
  const v=$("#viewer"), el=$(`#pages .page[data-page="${page}"]`); if(!v||!el) return;
  v.scrollTop=el.offsetTop+y*el.offsetHeight-v.clientHeight/3;
  if(window.innerWidth<=860){S.panelOpen=false; $("#reader").classList.add("panel-hidden")}
  const tryFlash=(n)=>{const els=document.querySelectorAll(sel); if(els.length){els.forEach(z=>{z.classList.remove("flash");void z.offsetWidth;z.classList.add("flash")})} else if(n<20) setTimeout(()=>tryFlash(n+1),150)};
  tryFlash(0);
}

/* ---------------- panel ---------------- */
let panelTimer=null;
function renderPanelSoon(){clearTimeout(panelTimer); panelTimer=setTimeout(()=>{if(S.panelTab==="annots") renderPanel()},600)}
function renderPanel(){
  const panel=$("#panel"); if(!panel||!S.cur) return;
  const p=S.papers.get(S.cur.id); const ann=S.cur.ann;
  const nAnn=ann.hl.length+ann.st.length;
  const active=document.activeElement; const keepId=active&&panel.contains(active)?active.id:null; const keepPos=keepId&&active.selectionStart;
  const scrollTop=($(".pbody",panel)||{}).scrollTop||0;
  let body;
  if(S.panelTab==="notes"){
    const meta=[p.authors,p.year,p.venue].filter(Boolean).map(esc).join(" · ");
    body=`<div class="pmeta"><div class="t">${esc(p.title)}</div><div class="m">${meta||'<span class="muted">No author or year yet.</span>'}${p.doi?`<br><span style="font-family:var(--f-mono);font-size:12px">${/^https?:/.test(p.doi)?`<a href="${esc(p.doi)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(p.doi)}</a>`:`<a href="https://doi.org/${esc(p.doi)}" target="_blank" rel="noopener" style="color:var(--accent)">doi:${esc(p.doi)}</a>`}</span>`:""}</div>
      <div class="acts"><div class="seg" role="group" aria-label="Status">${STATUSES.map(([k,l])=>`<button data-setstatus="${k}" class="${p.status===k?"on":""}">${l}</button>`).join("")}</div>
      <button class="btn ghost" data-togkey style="padding:3px 7px;font-size:12px"><span class="star">${p.key?"★":"☆"}</span> Key</button>
      <button class="btn ghost" data-editp style="padding:3px 7px;font-size:12px">${ICON.edit} Details</button></div>
      ${(p.tags||[]).length?`<div class="tags" style="display:flex;gap:4px;flex-wrap:wrap;margin-top:8px">${p.tags.map(t=>`<span class="tag">${esc(t)}</span>`).join("")}</div>`:""}</div>
      ${NOTE_FIELDS.map(([k,l,hint])=>`<div class="field"><label for="nf_${k}">${l}</label>${hint?`<span class="hint">${hint}</span>`:""}<textarea id="nf_${k}" data-nf="${k}" rows="2">${esc((p.notes||{})[k]||"")}</textarea></div>`).join("")}`;
  }else{
    const items=[...ann.hl.map(h=>({...h,kind:"hl",y:h.rects[0]?h.rects[0][1]:0})),...ann.st.map(s=>({...s,kind:"st"}))]
      .filter(a=>S.annFilter==="all"||(S.annFilter==="st"?a.kind==="st":a.kind==="hl"&&a.color===S.annFilter))
      .sort((a,b)=>a.page-b.page||a.y-b.y);
    const label=c=>(COLORS.find(z=>z[0]===c)||[,""])[1];
    body=`<div class="afilter"><div class="seg">${[["all","All"],["st","Stickies"]].map(([k,l])=>`<button data-af="${k}" class="${S.annFilter===k?"on":""}">${l}</button>`).join("")}</div>
      <div class="swatches">${COLORS.map(([c,l])=>`<button class="sw${S.annFilter===c?" on":""}" data-af="${c}" title="Only ${l}" aria-label="Only ${l}" style="background:var(--hl-${c})"></button>`).join("")}</div></div>
      ${items.length?`<div class="alist">${items.map(a=>a.kind==="hl"
        ?`<button class="aitem" data-jhl="${a.id}"><span class="dot" style="background:var(--hl-${a.color})"></span><span style="min-width:0"><span class="pg">p. ${a.page} · ${label(a.color)}</span><div class="qt">${esc(a.text.length>320?a.text.slice(0,320)+"…":a.text)}</div>${a.comment?`<div class="cm">${esc(a.comment)}</div>`:""}</span></button>`
        :`<button class="aitem" data-jst="${a.id}"><span class="dot" style="background:var(--hl-${a.color});border-radius:2px 2px 2px 5px"></span><span style="min-width:0"><span class="pg">p. ${a.page} · Sticky note</span><div class="cm" style="color:var(--ink);margin-top:2px">${a.text?esc(a.text):'<span class="muted">Empty note</span>'}</div></span></button>`).join("")}</div>`
      :`<p class="muted" style="font-size:13px">${nAnn?"Nothing matches this filter.":"No highlights or sticky notes yet. Select text on the page to highlight it, or choose Sticky and click the page."}</p>`}`;
  }
  panel.innerHTML=`<div class="ptabs"><button class="ptab${S.panelTab==="notes"?" on":""}" data-tab="notes">Review notes</button><button class="ptab${S.panelTab==="annots"?" on":""}" data-tab="annots">Annotations <span class="n">${nAnn}</span></button><div class="spacer"></div><button class="btn ghost panel-close" data-closepanel aria-label="Hide notes" style="align-self:center;padding:3px 6px">${ICON.x}</button></div>
    <div class="pbody">${body}</div>
    <div class="pfoot"><button class="btn" data-export>${ICON.download} Export notes</button><button class="btn ghost" data-orig>${ICON.open} Original PDF</button></div>`;
  const pb=$(".pbody",panel); pb.scrollTop=scrollTop;
  panel.querySelectorAll("textarea[data-nf]").forEach(ta=>{
    autosize(ta);
    ta.addEventListener("input",()=>{p.notes=p.notes||{}; p.notes[ta.dataset.nf]=ta.value; p.updated=Date.now(); autosize(ta); savePaperSoon(p.id,900)});
  });
  if(keepId){const el=document.getElementById(keepId); if(el){el.focus(); try{el.setSelectionRange(keepPos,keepPos)}catch(e){}}}
}
function autosize(ta){ta.style.height="auto"; ta.style.height=Math.max(58,ta.scrollHeight+2)+"px"}
document.addEventListener("click",e=>{
  if(S.view!=="reader") return;
  const panel=$("#panel"); if(!panel||!panel.contains(e.target)) return;
  const t=e.target.closest("[data-tab],[data-setstatus],[data-togkey],[data-editp],[data-af],[data-jhl],[data-jst],[data-export],[data-closepanel],[data-orig]"); if(!t) return;
  const c=S.cur, p=S.papers.get(c.id);
  if(t.dataset.tab){S.panelTab=t.dataset.tab; renderPanel()}
  else if(t.dataset.setstatus){p.status=t.dataset.setstatus; savePaperSoon(p.id,0); renderPanel()}
  else if(t.hasAttribute("data-togkey")){p.key=!p.key; savePaperSoon(p.id,0); renderPanel()}
  else if(t.hasAttribute("data-editp")){editPaper(p.id)}
  else if(t.dataset.af){S.annFilter=S.annFilter===t.dataset.af&&t.dataset.af!=="all"?"all":t.dataset.af; renderPanel()}
  else if(t.dataset.jhl){const h=c.ann.hl.find(z=>z.id===t.dataset.jhl); if(h) jumpTo(h.page,h.rects[0]?h.rects[0][1]:0,`[data-hl="${h.id}"]`)}
  else if(t.dataset.jst){const s=c.ann.st.find(z=>z.id===t.dataset.jst); if(s){jumpTo(s.page,s.y,`[data-st="${s.id}"]`); if(c.openSticky!==s.id) setTimeout(()=>toggleSticky(s.id),300)}}
  else if(t.hasAttribute("data-export")){exportOne(p,c.ann)}
  else if(t.hasAttribute("data-orig")){openOriginal(p)}
  else if(t.hasAttribute("data-closepanel")){S.panelOpen=false; $("#reader").classList.add("panel-hidden")}
});

/* ---------------- export ---------------- */
function paperMarkdown(p,ann){
  const L=[]; const lab=c=>(COLORS.find(z=>z[0]===c)||[,c])[1];
  L.push(`# ${p.title}`,"");
  const ref=[p.authors,p.year&&`(${p.year})`,p.venue].filter(Boolean).join(" ");
  if(ref) L.push(ref);
  if(p.doi) L.push(/^https?:/.test(p.doi)?p.doi:`https://doi.org/${p.doi}`);
  L.push(`Status: ${(STATUSES.find(s=>s[0]===p.status)||STATUSES[0])[1]}${p.key?" · Key paper":""}${(p.tags||[]).length?" · Tags: "+p.tags.join(", "):""}`,"");
  NOTE_FIELDS.forEach(([k,l])=>{const v=((p.notes||{})[k]||"").trim(); if(v) L.push(`## ${l}`,"",v,"")});
  const hl=(ann&&ann.hl||[]).slice().sort((a,b)=>a.page-b.page||(a.rects[0]||[0,0])[1]-(b.rects[0]||[0,0])[1]);
  if(hl.length){L.push("## Highlights",""); hl.forEach(h=>{L.push(`> ${h.text}`,`> (p. ${h.page}, ${lab(h.color)})`); if(h.comment) L.push("",h.comment); L.push("")})}
  const st=(ann&&ann.st||[]).filter(s=>s.text&&s.text.trim()).sort((a,b)=>a.page-b.page||a.y-b.y);
  if(st.length){L.push("## Sticky notes",""); st.forEach(s=>L.push(`- p. ${s.page}: ${s.text.trim().replace(/\n+/g," ")}`)); L.push("")}
  return L.join("\n");
}
function slug(s){return (s||"notes").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,60)||"notes"}
function exportOne(p,ann){deliver(`${slug(citeKey(p)+" "+p.title)}.md`,paperMarkdown(p,ann))}
async function exportAll(){
  const list=filtered(); if(!list.length){toast("No papers to export.");return}
  toast("Preparing export…");
  const parts=[];
  for(const p of list){
    let ann={hl:[],st:[]};
    if(S.mode==="store"){try{const a=await idbGet("annots",p.id); if(a) ann=a}catch(e){}} else if(p._ann) ann=p._ann;
    parts.push(paperMarkdown(p,ann));
  }
  deliver(`literature-notes-${new Date().toISOString().slice(0,10)}.md`,parts.join("\n\n---\n\n"));
}
function saveBlob(filename,blob){
  const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=filename;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),60000);
}
function deliver(filename,text){saveBlob(filename,new Blob([text],{type:"text/markdown"}))}
async function openOriginal(p){
  let blob=null;
  if(S.mode==="store"&&p.asset) blob=await idbGet("files",p.asset).catch(()=>null);
  else if(p._buf) blob=new Blob([p._buf],{type:"application/pdf"});
  if(!blob){toast("The PDF file is missing.");return}
  const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.target="_blank"; a.rel="noopener";
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),120000);
}

/* ---------------- backup & restore (store-only .zip) ---------------- */
const CRC=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0}return t})();
function crc32(u8){let c=0xFFFFFFFF;for(let i=0;i<u8.length;i++)c=CRC[(c^u8[i])&255]^(c>>>8);return (c^0xFFFFFFFF)>>>0}
function makeZip(entries){
  const enc=new TextEncoder(); const parts=[]; const cd=[]; let off=0;
  const d=new Date(); const dt=((d.getHours()<<11)|(d.getMinutes()<<5)|(d.getSeconds()>>1))&0xFFFF; const dd=(((d.getFullYear()-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate())&0xFFFF;
  for(const {name,data} of entries){
    const nb=enc.encode(name); const crc=crc32(data);
    const h=new DataView(new ArrayBuffer(30));
    h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(6,0x0800,true);h.setUint16(8,0,true);h.setUint16(10,dt,true);h.setUint16(12,dd,true);
    h.setUint32(14,crc,true);h.setUint32(18,data.length,true);h.setUint32(22,data.length,true);h.setUint16(26,nb.length,true);h.setUint16(28,0,true);
    parts.push(h.buffer,nb,data);
    const c=new DataView(new ArrayBuffer(46));
    c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x0800,true);c.setUint16(10,0,true);c.setUint16(12,dt,true);c.setUint16(14,dd,true);
    c.setUint32(16,crc,true);c.setUint32(20,data.length,true);c.setUint32(24,data.length,true);c.setUint16(28,nb.length,true);c.setUint32(42,off,true);
    cd.push(c.buffer,nb); off+=30+nb.length+data.length;
  }
  const cdSize=cd.reduce((a,b)=>a+b.byteLength,0);
  const e=new DataView(new ArrayBuffer(22));
  e.setUint32(0,0x06054b50,true);e.setUint16(8,entries.length,true);e.setUint16(10,entries.length,true);e.setUint32(12,cdSize,true);e.setUint32(16,off,true);
  return new Blob([...parts,...cd,e.buffer],{type:"application/zip"});
}
function readZip(buf){
  const v=new DataView(buf), u8=new Uint8Array(buf), dec=new TextDecoder(); let eo=-1;
  for(let i=buf.byteLength-22;i>=Math.max(0,buf.byteLength-65557);i--){if(v.getUint32(i,true)===0x06054b50){eo=i;break}}
  if(eo<0) throw new Error("This isn't a Marginalia backup file.");
  const n=v.getUint16(eo+10,true); let p=v.getUint32(eo+16,true); const out=new Map();
  for(let k=0;k<n;k++){
    if(v.getUint32(p,true)!==0x02014b50) throw new Error("The backup file is damaged.");
    const method=v.getUint16(p+10,true), size=v.getUint32(p+20,true), nl=v.getUint16(p+28,true), xl=v.getUint16(p+30,true), cl=v.getUint16(p+32,true), lo=v.getUint32(p+42,true);
    const name=dec.decode(u8.subarray(p+46,p+46+nl));
    if(method!==0) throw new Error("This backup was changed by another program and can't be read. Use the original file.");
    const ds=lo+30+v.getUint16(lo+26,true)+v.getUint16(lo+28,true);
    out.set(name,u8.subarray(ds,ds+size)); p+=46+nl+xl+cl;
  }
  return out;
}
async function backupLibrary(){
  if(!S.papers.size){toast("Your library is empty, so there's nothing to back up yet.");return}
  toast("Preparing backup…");
  const enc=new TextEncoder(); const entries=[]; const annots={}; const papers=[];
  for(const p of S.papers.values()){
    if(p._busy) continue;
    papers.push(paperBody(p));
    let a=null, blob=null;
    if(S.mode==="store"){a=await idbGet("annots",p.id).catch(()=>null); if(p.asset) blob=await idbGet("files",p.asset).catch(()=>null)}
    else{a=p._ann||null; if(p._buf) blob=new Blob([p._buf])}
    if(a) annots[p.id]={hl:a.hl||[],st:a.st||[]};
    if(blob) entries.push({name:`pdfs/${p.id}.pdf`,data:new Uint8Array(await blob.arrayBuffer())});
  }
  const lib={app:"marginalia",format:1,exported:new Date().toISOString(),papers,annots};
  entries.unshift({name:"library.json",data:enc.encode(JSON.stringify(lib,null,1))});
  saveBlob(`marginalia-backup-${new Date().toISOString().slice(0,10)}.zip`,makeZip(entries));
  lsSet("mg.lastBackup",Date.now()); updateBackupNote();
}
async function restoreLibrary(file){
  let files, lib;
  try{files=readZip(await file.arrayBuffer()); const j=files.get("library.json"); if(!j) throw new Error("This isn't a Marginalia backup file."); lib=JSON.parse(new TextDecoder().decode(j)); if(lib.app!=="marginalia") throw new Error("This isn't a Marginalia backup file.")}
  catch(e){toast(e.message||"Couldn't read that backup.");return}
  const incoming=lib.papers||[]; const clash=incoming.filter(p=>S.papers.has(p.id)).length;
  const sc=document.createElement("div"); sc.className="scrim";
  sc.innerHTML=`<div class="modal"><h3>Restore from backup</h3>
    <p style="margin:0">This backup from ${esc(new Date(lib.exported).toLocaleString("en-GB",{dateStyle:"medium",timeStyle:"short"}))} holds ${incoming.length} paper${incoming.length===1?"":"s"}.</p>
    <p class="muted" style="margin:0;font-size:13px">${clash?`${clash} of them ${clash===1?"is":"are"} already in your library and will be replaced by the backed-up version, including notes and highlights. `:""}Papers that are only in your current library stay as they are.</p>
    <div class="foot"><div class="spacer"></div><button class="btn" id="rsCancel">Cancel</button><button class="btn primary" id="rsGo">Restore ${incoming.length} paper${incoming.length===1?"":"s"}</button></div></div>`;
  document.body.appendChild(sc);
  sc.onclick=e=>{if(e.target===sc)sc.remove()}; $("#rsCancel",sc).onclick=()=>sc.remove();
  $("#rsGo",sc).onclick=async()=>{
    sc.remove(); let n=0;
    for(const p of incoming){
      const pdf=files.get(`pdfs/${p.id}.pdf`); const a=(lib.annots||{})[p.id]||{hl:[],st:[]};
      const paper={...p}; delete paper._busy;
      if(S.mode==="store"){
        if(pdf){await idbPut("files",p.id,new Blob([pdf],{type:"application/pdf"})); paper.asset=p.id}
        await idbPut("annots",p.id,a); await idbPut("papers",p.id,paper);
      }else{if(pdf) paper._buf=pdf.slice().buffer; paper._ann=a}
      S.papers.set(p.id,paper); n++;
    }
    lsSet("mg.changed",Date.now()); render(); toast(`Restored ${n} paper${n===1?"":"s"}.`);
  };
}
function backupNoteText(){
  const last=lsGet("mg.lastBackup",0), changed=lsGet("mg.changed",0);
  if(!S.papers.size) return {t:"",warn:false};
  if(!last) return {t:"Not backed up yet",warn:true};
  const days=Math.floor((Date.now()-last)/864e5);
  const when=days<1?"today":days===1?"yesterday":`${days} days ago`;
  return {t:`Last backup ${when}`,warn:changed>last&&days>=7};
}
function updateBackupNote(){const el=$("#backupNote"); if(!el) return; const b=backupNoteText(); el.textContent=b.t; el.style.color=b.warn?"var(--warn)":"var(--muted)"}
$("#restoreIn").addEventListener("change",e=>{const f=e.target.files[0]; e.target.value=""; if(f) restoreLibrary(f)});

function copyText(t){
  try{return navigator.clipboard.writeText(t).then(()=>true,()=>false)}catch(e){return Promise.resolve(false)}
}

/* ---------------- shell ---------------- */
let toastT=null;
function toast(msg){let t=$(".toast"); if(!t){t=document.createElement("div");t.className="toast";t.setAttribute("role","status");document.body.appendChild(t)} t.textContent=msg; clearTimeout(toastT); toastT=setTimeout(()=>t.remove(),3600)}
function render(){
  $("#topbar").hidden=S.view==="reader"&&window.innerWidth<=860;
  if(S.view==="reader"&&S.cur){ if(!$("#viewer")) renderReader(); else {renderPanel(); const p=S.papers.get(S.cur.id), rt=$(".rtitle"); if(p&&rt){rt.textContent=p.title; rt.title=p.title}} }
  else renderLibrary();
}
window.addEventListener("beforeunload",e=>{if(pending>0){e.preventDefault();e.returnValue=""}});

/* ---------------- private cloud account ---------------- */
function cloudAuthUI(){
  if(!document.getElementById("cloudAuthStyle")){
    const style=document.createElement("style"); style.id="cloudAuthStyle"; style.textContent=`
      #cloudLoginScreen{position:fixed;inset:0;z-index:2147483000;background:radial-gradient(ellipse at top left,#e7eafe,transparent 50%),#f4f5f8;color:#202638;display:grid;place-items:center;padding:24px;font-family:Inter,system-ui,sans-serif}
      #cloudLoginScreen *{box-sizing:border-box}#cloudLoginScreen .cl-card{width:min(100%,440px);padding:34px;border:1px solid #dce0ea;border-radius:18px;background:white;box-shadow:0 24px 80px #20263818}
      #cloudLoginScreen .cl-kicker{font-size:10px;letter-spacing:.15em;font-weight:800;color:#4656c5;margin:0 0 12px}#cloudLoginScreen h1{font-size:32px;letter-spacing:-.05em;margin:0 0 10px}#cloudLoginScreen .cl-sub{font-size:13px;color:#697185;line-height:1.6;margin:0 0 24px}
      #cloudLoginScreen form{display:grid;gap:15px}#cloudLoginScreen label{display:grid;gap:7px;font-size:12px;font-weight:700;color:#656d7e}#cloudLoginScreen input{padding:12px;border:1px solid #dce0e8;border-radius:8px;font:inherit;font-size:14px;color:#202638;background:white}
      #cloudLoginScreen button{padding:12px;border:0;border-radius:8px;background:#394dca;color:white;font-weight:750;cursor:pointer}#cloudLoginScreen .cl-error{color:#b52f43;font-size:12px;min-height:0;margin:0}#cloudLoginScreen .cl-foot{font-size:11px;color:#8990a0;text-align:center;margin:20px 0 0}
      #cloudAccountBadge{position:static;z-index:auto;display:flex;align-items:center;gap:9px;background:#fff;border:1px solid #dce0e8;border-radius:9px;padding:5px 7px 5px 11px;color:#41495b;font:11px system-ui,sans-serif;box-shadow:none;flex-shrink:0;max-width:55vw}#cloudAccountBadge>span:nth-child(2){overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}
      #cloudAccountBadge button{border:1px solid #dce0e8;border-radius:7px;background:#f7f8fb;color:#41495b;padding:5px 8px;font-size:11px;cursor:pointer}#cloudAccountBadge .cl-online{width:7px;height:7px;background:#35a36a;border-radius:50%;display:inline-block}
      @media(prefers-color-scheme:dark){#cloudLoginScreen{background:radial-gradient(ellipse at top left,#242c54,transparent 50%),#12151b;color:#e8ebf4}#cloudLoginScreen .cl-card{background:#1c212b;color:#e8ebf4;border-color:#323949}#cloudLoginScreen .cl-sub,#cloudLoginScreen label,#cloudLoginScreen .cl-foot{color:#a4adbd}#cloudLoginScreen input{background:#141821;color:#f0f2f7;border-color:#3b4353}#cloudAccountBadge{background:#1c212b;border-color:#343c4c;color:#e8ebf4}#cloudAccountBadge button{background:#262d3a;color:#e8ebf4;border-color:#3b4353}}
    `; document.head.appendChild(style);
  }
  let screen=document.getElementById("cloudLoginScreen");
  if(!screen){
    screen=document.createElement("section");screen.id="cloudLoginScreen";
    screen.innerHTML=`<div class="cl-card"><p class="cl-kicker">PRIVATE RESEARCH LIBRARY</p><h1>Welcome back.</h1><p class="cl-sub">Sign in to open your papers in the Marginalia PDF reader. Your library, highlights and notes are stored under your authorised account.</p><form id="cloudLoginForm"><label>Email address<input name="email" type="email" autocomplete="username" required placeholder="you@example.com"></label><label>Password<input name="password" type="password" autocomplete="current-password" required placeholder="Your password"></label><button type="submit">Sign in →</button><p id="cloudLoginError" class="cl-error" role="alert"></p></form><p class="cl-foot">Private account access · No public sign-up</p></div>`;
    document.body.appendChild(screen);
    screen.querySelector("form").addEventListener("submit",async e=>{
      e.preventDefault(); const f=e.currentTarget; const button=f.querySelector("button"); const error=screen.querySelector("#cloudLoginError");
      error.textContent=""; button.disabled=true; button.textContent="Signing in…";
      try{
        const email=f.elements.email.value.trim().toLowerCase(), password=f.elements.password.value;
        const result=await fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,password})});
        const data=await result.json().catch(()=>({})); if(!result.ok) throw new Error(data.error||"Sign-in failed.");
        cloudToken=data.token;sessionStorage.setItem("marginalia_token",cloudToken);screen.remove();showCloudAccount(email);await boot();
      }catch(err){error.textContent=err.message;button.disabled=false;button.textContent="Sign in →";}
    });
  }
  return screen;
}
function showCloudAccount(email){
  let badge=document.getElementById("cloudAccountBadge"); if(!badge){badge=document.createElement("div");badge.id="cloudAccountBadge";const topbar=document.getElementById("topbar"), saveState=document.getElementById("saveState");if(topbar)topbar.insertBefore(badge,saveState||null);else document.body.appendChild(badge)}
  badge.innerHTML=`<span class="cl-online"></span><span>${esc(email)}</span><button type="button" id="cloudSignOut">Sign out</button>`;
  badge.querySelector("#cloudSignOut").onclick=()=>{sessionStorage.removeItem("marginalia_token");cloudToken="";location.reload()};
}
async function initCloudAuth(){
  const screen=cloudAuthUI();
  if(cloudToken){
    try{const me=await cloudRequest("/api/auth/me");screen.remove();showCloudAccount(me.user.email);await boot();return}
    catch{cloudToken="";sessionStorage.removeItem("marginalia_token");}
  }
  screen.style.display="grid";
}

if(!window.pdfjsLib){$("#view").innerHTML='<div class="empty-state"><h2>The PDF reader didn\'t load</h2><p>Refresh the page and try again.</p></div>'}
else { pdfjsLib.GlobalWorkerOptions.workerSrc="/pdf.worker.js"; initCloudAuth(); }
})();

