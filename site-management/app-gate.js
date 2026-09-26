(function(){'use strict';
// Presentation gate only. Every shared read/write still requires server ACL.
let generation=0;const drafts=new Set(),companyAllowed=new Set();
const identity=()=>portalSession.connected()?portalSession.identity():null;
const snapshot=()=>window.siteSharedProfilesSnapshot?.()||{ready:false,rows:[]};
const row=id=>snapshot().rows.find(r=>String(r.localId)===String(id))||(drafts.has(String(id))?{sections:['概要'],can_manage_members:true,draft:true}:null);
const sections=r=>[...(r?.sections||[]),...(r?.profile&&r?.sections?.includes('概要')?['関連']:[]),...(r?.can_manage_members?['メンバー']:[]),...(companyAllowed.has('profits')?['利益管理']:[])];
// These sections have shared adapters. Unmigrated local sections must not be
// exposed merely because a server row permits that section.
const shared=new Set(['概要']);
const globalSections={allTasks:'タスク',allReports:'報告',repairs:'手直し案件',accidents:'事故報告'};
function sharedReady(t){return shared.has(t)||window.appSharedFeatures?.[t]===true}
const canCreate=()=>companyAllowed.has('customers');
const globalAllowed=p=>!!identity()&&snapshot().ready&&!!globalSections[p]&&window.appSharedFeatures?.[p]===true&&snapshot().rows.some(r=>r.sections?.includes(globalSections[p]));
const navPage=b=>b.dataset.nav||(b.hasAttribute('data-estimates')?'estimates':b.dataset.work==='tasks'?'allTasks':b.dataset.work==='reports'?'allReports':b.hasAttribute('data-accidents')?'accidents':b.hasAttribute('data-order-notice')?'inventory':'');
const navAllowed=n=>n==='sites'||(['employees','subcontractors'].includes(n)&&window.sharedWorkforceAvailable?.()&&window.appSharedFeatures?.[n]===true)||globalAllowed(n)||(companyAllowed.has(n)&&window.appSharedFeatures?.[n]===true);
function updateNav(){const employee=(identity()?.kind||'employee')==='employee',employeeOnly=new Set(['employees','subcontractors','profits','customers','estimates','safetyLibrary','inventory']);for(const b of document.querySelectorAll('aside nav button')){const n=navPage(b),ready=n==='sites'||!!identity()&&snapshot().ready&&window.appSharedFeatures?.[n]===true&&(!employeeOnly.has(n)||employee);b.hidden=!ready;b.disabled=ready&&!navAllowed(n);b.title=b.disabled?'閲覧できる現場または担当権限がありません':''}}
const allowed=(id,t)=>!!identity()&&snapshot().ready&&sections(row(id)).includes(t);
function clearModal(){const modal=$('modal');if(!modal)return;if(modal.open)closeModal();modal.replaceChildren()}
function notice(text){clearModal();$('app').innerHTML='<section class="panel"><h1>現場管理</h1><p>'+esc(text)+'</p><button class="secondary" onclick="siteSharedProfilesRefresh()">再確認する</button></section>'}
function loginNotice(){clearModal();$('app').innerHTML='<section class="panel"><h1>現場管理</h1><p>本人のポータルにログインすると、閲覧できる現場が表示されます。</p><p style="display:flex;flex-wrap:wrap;gap:10px"><a class="primary" id="employeePortalLogin" style="display:inline-block;color:#fff;text-decoration:none" href="https://shota-1003.github.io/jinshou-employee-app/">社員ログイン</a> <a class="secondary" style="display:inline-block;text-decoration:none" id="workerPortalLogin" href="https://shota-1003.github.io/jinshou-employee-app/sub/">協力会社ログイン</a></p><p>ログイン後、ブラウザーの戻るでこの画面に戻ってください。ログイン状態を自動で確認します。</p><button class="secondary" onclick="siteSharedProfilesRefresh()">再確認する</button></section>';function mode(worker){const url=new URL(location.href);if(worker)url.searchParams.set('portal','sub');else url.searchParams.delete('portal');history.replaceState(history.state,'',url)}$('employeePortalLogin').addEventListener('click',()=>mode(false));$('workerPortalLogin').addEventListener('click',()=>mode(true))}
window.appGateCanMount=(p=page,id=siteId,t=tab)=>!!identity()&&snapshot().ready&&(p==='detail'?allowed(id,t)&&sharedReady(t):globalAllowed(p)||companyAllowed.has(p)&&window.appSharedFeatures?.[p]===true);
function sharedCard(r,i){const p=r.profile||{},name=r.name||p.name||'現場';return `<article class="project-card wide-open-target" data-gate-card="${esc(r.localId)}" tabindex="0" role="button" aria-label="${esc(name)}を開く" data-search="${esc(name+' '+(p.address||''))}"><div class="project-art">${art({id:i+1})}<span class="art-label">JINSHOU / PROJECT</span><span class="art-num">${String(i+1).padStart(3,'0')}</span></div><div class="project-info">${p.status?pill(p.status):''}<h2><button class="text-action" style="font-size:inherit;color:inherit;font-weight:inherit;text-align:left" data-gate-site="${esc(r.localId)}">${esc(name)}</button></h2>${p.address?`<p class="meta">${esc(p.address)}</p>`:''}<button class="project-open" aria-label="現場を開く" data-gate-site="${esc(r.localId)}"><span>現場の詳細を見る</span><span>↗</span></button></div></article>`}
function portalOrder(rows){return rows.map((r,i)=>({r,i,rank:Number(r.portal_order)})).sort((a,b)=>{const ar=Number.isSafeInteger(a.rank)&&a.rank>0,br=Number.isSafeInteger(b.rank)&&b.rank>0;return ar&&br?a.rank-b.rank||a.i-b.i:ar?-1:br?1:a.i-b.i}).map(x=>x.r)}
function list(){const base=snapshot(),s={...base,rows:portalOrder([...base.rows,...state.sites.filter(r=>drafts.has(String(r.id))&&!base.rows.some(x=>String(x.localId)===String(r.id))).map(r=>({name:r.name,localId:r.id}))])};$('app').innerHTML=heading('PROJECTS','参加している現場','メンバーとして閲覧を許可された現場です。登録が新しい順（ポータル未連携の現場は末尾）に表示しています。')+(canCreate()?'<button class="primary" onclick="siteForm()">＋ 現場を登録</button>':'')+(s.ready?'<div class="project-grid">'+s.rows.map(sharedCard).join('')+'</div><p class="hint">建物のカバーはイメージ図です。現場に保存した写真とは別です。</p>':'<p>'+esc(s.error||'ログインと現場を確認中です。')+'</p>');if(s.ready&&!s.rows.length)$('app').insertAdjacentHTML('beforeend','<p>閲覧できる現場がありません。現場の職長・リーダーにメンバー登録を依頼してください。</p>');document.querySelectorAll('[data-gate-site]').forEach(b=>b.onclick=e=>{e.stopPropagation();openSite(Number(b.dataset.gateSite))});document.querySelectorAll('[data-gate-card]').forEach(card=>{card.onclick=e=>{if(e.target.closest('button,a,input,select,textarea'))return;openSite(Number(card.dataset.gateCard))};card.onkeydown=e=>{if(e.target===card&&['Enter',' '].includes(e.key)){e.preventDefault();openSite(Number(card.dataset.gateCard))}}})}
window.addEventListener('DOMContentLoaded',()=>{
 const previous=render;
 render=function(){
  updateNav();
  if(!identity()){loginNotice();return}
  if(page==='sites'){list();return}
  if(['employees','subcontractors'].includes(page)){if(window.sharedWorkforceAvailable?.()&&window.appSharedFeatures?.[page]===true){previous();updateNav();return}notice('管理できる現場と本人ログインを確認してください。');return}
  if(globalSections[page]){if(globalAllowed(page)){previous();updateNav();return}notice('この一覧を閲覧できる現場と共有画面を確認してください。');return}
  if(companyAllowed.has(page)){if(!snapshot().ready){notice('現場の閲覧権限を確認中です。再確認してください。');return}if(window.appSharedFeatures?.[page]!==true){notice('この機能は共有画面への切り替え準備中です。');return}previous();updateNav();return}
  if(page!=='detail'){notice('この機能は現場を開いて利用してください。');return}
  const r=row(siteId);if(!snapshot().ready||!r){notice('この現場を閲覧できません。現場一覧から選び直してください。');return}
  if(!allowed(siteId,tab)){notice('この項目は閲覧対象ではありません。');return}
  if(!sharedReady(tab)){notice('この項目は共有画面への切り替え準備中です。');return}
  previous();updateNav();
  const tabs=document.querySelector('#app .tabs');if(tabs)for(const b of [...tabs.children]){const name=b.textContent.replace(/^🔒\s*/, '').replace(/\s+\d+$/, '').trim();if(!allowed(siteId,name)||!sharedReady(name))b.remove()}
 };
 const guardedRender=render;render=function(){try{const result=guardedRender();document.documentElement.removeAttribute('data-app-gate-loading');return result}catch(e){clearModal();$('app').innerHTML='<section class="panel"><h1>現場管理</h1><p>画面を確認できません。再読み込みしてください。</p></section>';document.querySelectorAll('aside nav button').forEach(b=>b.hidden=navPage(b)!=='sites');document.documentElement.removeAttribute('data-app-gate-loading');console.error('app gate render failed',e)}};window.appGateRender=render;
 openSite=function(id){const r=row(id),first=sections(r).find(sharedReady);if(!r||!first){notice('閲覧できる項目がありません。');return}siteId=id;page='detail';tab=first;render()};
 const oldForm=siteForm;siteForm=async function(id){if(id==null&&!canCreate())return notice('新しい現場の共有登録は会社の管理担当者に依頼してください');if(!identity()||(identity().kind||'employee')!=='employee')return notice('社員のログインを確認してください');if(id!=null&&!row(id))return notice('この現場は編集対象ではありません');const formGeneration=generation;await oldForm(id);if(formGeneration!==generation){closeModal();return}if(id!=null)return;const f=$('siteForm');if(!f)return;const beforeIds=new Set(state.sites.map(s=>String(s.id))),g=generation,actor=JSON.stringify(identity()),oldSave=save;let active=true,submitting=false;const hook=function(){const result=oldSave();if(active&&submitting&&g===generation&&actor===JSON.stringify(identity()))for(const r of state.sites)if(!r.__sharedOnly&&!beforeIds.has(String(r.id))&&r.name===f.elements.name.value)drafts.add(String(r.id));return result};save=hook;f.addEventListener('submit',()=>{submitting=true},{capture:true});$('modal').addEventListener('close',()=>{active=false;if(save===hook)save=oldSave},{once:true})};
 const oldGo=goTab;goTab=function(id,t){if(!allowed(id,t)){notice('この項目は閲覧対象ではありません。');return}return oldGo(id,t)};
 window.addEventListener('portal-session-ready',()=>{generation++;drafts.clear();companyAllowed.clear();clearModal();page='sites';render();loadCompany()});
 async function loadCompany(){const g=generation,actor=identity();if(!actor||(actor.kind||'employee')!=='employee')return;for(const [p,section]of [['customers','顧客・取引先'],['estimates','見積・受注'],['profits','利益管理']]){try{await siteSharedStore.list('__company__',section);if(g!==generation)return;if(siteSharedStore.access('__company__',section)?.read)companyAllowed.add(p)}catch{} }
  try{const r=await portalSession.call('educationLibraryRead',{p_actor_kind:'employee',p_actor_code:actor.code,p_site_key:null,p_id:null,p_after_id:null});if(g===generation&&Array.isArray(r))companyAllowed.add('safetyLibrary')}catch{}
  try{const r=await portalSession.call('inventory',{action:'capabilities'});if(g===generation&&r&&typeof r==='object')companyAllowed.add('inventory')}catch{}
  if(g===generation)render()}
 render();loadCompany();
});
})();

