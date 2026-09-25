// Integration layer for the independent field-management prototype.
const baseOperationsRender=render;
function ensureOperationsNavigation(){
 const nav=document.querySelector('aside nav');
 if(!nav.querySelector('[data-nav="inventory"]')){
  const button=document.createElement('button');button.dataset.nav='inventory';
  button.textContent='▥　資材管理';button.onclick=()=>navigate('inventory');nav.append(button);
 }
}
function operationsBody(html){const tabs=$('app').querySelector('.tabs');if(!tabs)return;while(tabs.nextSibling)tabs.nextSibling.remove();const body=document.createElement('div');body.id='operations-content';body.innerHTML=html;tabs.after(body)}
render=function(){
 // The earlier renderer expects a site for every non-directory page.
 if(page==='inventory'){
  ensureOperationsNavigation();document.querySelectorAll('[data-nav]').forEach(e=>e.classList.toggle('active',e.dataset.nav==='inventory'));
  $('app').innerHTML=typeof renderInventory==='function'?renderInventory():'<section class="panel">資材管理を準備しています。</section>';return;
 }
 baseOperationsRender();ensureOperationsNavigation();
 if(page==='sites'){
  document.querySelectorAll('.project-card').forEach((card,index)=>{
   const s=state.sites[index];if(!s)return;
   const summary=document.createElement('div');summary.className='mini-metrics operations-card-summary';
   const registered=typeof kyStatus==='function'&&kyStatus(s.id).registered;
   const items=typeof inventorySummary==='function'?inventorySummary(s.id).filter(i=>i.held>0).length:0;
   summary.innerHTML=`<button data-ky-status-text onclick="goTab(${s.id},'KY')">今日のKY ${registered?'✓ 登録済み':'未登録'}</button><button onclick="goTab(${s.id},'資材台帳')">持出資材 ${items}品目 →</button>`;
   card.querySelector('.project-open').before(summary);
   verifyKyDisplay(s.id,summary.querySelector('[data-ky-status-text]'));
  });
 }
 if(page!=='detail')return;
 const names=['概要','関連','工程表','タスク','報告','写真','資料','KY','資材台帳','チャット','手直し案件','入場履歴'];
 const tabs=$('app').querySelector('.tabs');
 if(!tabs)return;
 tabs.innerHTML=names.map(t=>`<button class="${tab===t?'active':''}" onclick="goTab(${siteId},'${t}')">${t}${t==='手直し案件'?' '+state.repairs.filter(r=>r.site===siteId&&r.status!=='完了').length:''}</button>`).join('');
 if(tab==='資材台帳'&&typeof renderInventory==='function')operationsBody(renderInventory(siteId));
 if(tab==='チャット'&&typeof renderSiteChat==='function')operationsBody(renderSiteChat(siteId));
 if(['写真','資料','KY'].includes(tab)&&typeof renderMedia==='function')operationsBody(renderMedia(siteId,tab));
 if(typeof hydrateMedia==='function'&&['写真','資料','KY'].includes(tab))hydrateMedia();
 if(['概要','報告'].includes(tab)&&typeof kyStatus==='function'){
  const status=kyStatus(siteId),banner=document.createElement('div');banner.className='notice ky-integration-banner';
  banner.innerHTML=status.registered?`<div class="row between"><span>✓ 今日のKYは登録済みです。</span><button class="text-action" onclick="goTab(${siteId},'KY')">KYを確認 →</button></div>`:`<div class="row between"><span>今日のKYが未登録です。危険要因・対策と実施記録を登録してください。</span><button class="secondary" onclick="kyForm(${siteId})">今日のKYを登録</button></div>`;
  tabs.after(banner);
 }
 const statusText=$('app').querySelector('.ky-banner b')||$('app').querySelector('.ky-integration-banner span');
 if(statusText)verifyKyDisplay(siteId,statusText);
};
async function verifyKyDisplay(sid,node){
 if(!node||!kyStatus(sid).registered)return;
 const fileId=kyStatus(sid).record.fileId;
 const readiness=await reportKyReadiness(sid);
 if(node.isConnected&&kyStatus(sid).record?.fileId===fileId&&readiness!=='ready'){
  node.textContent='KY原本が見つかりません。再添付してください。';
  const banner=node.closest('.ky-banner');if(banner)banner.classList.remove('complete');
 }
}
const beforeKyReportForm=reportForm;
async function reportKyReadiness(sid){
 const record=kyStatus(sid).record;
 if(!kyStatus(sid).registered)return 'unregistered';
 try{const blob=await mediaBlob(record.fileId),latest=kyStatus(sid);return blob&&latest.registered&&latest.record.fileId===record.fileId?'ready':'missing'}catch{return 'missing'}
}
reportForm=async function(){
 const sid=siteId,openedTab=tab;
 const readiness=await reportKyReadiness(sid);
 if(siteId!==sid||page!=='detail'||tab!==openedTab)return;
 if(readiness!=='ready'){
  notify(readiness==='missing'?'KY原本が見つかりません。原本を再添付してから報告してください。':'今日のKYを登録してから、通常報告を作成してください。');kyForm(sid);
  if(readiness==='missing'){$('kyForm').elements.attachment.required=true;$('kyForm').insertAdjacentHTML('afterbegin','<p class="notice">登録済みの原本がこの端末にありません。原本の再添付が必要です。</p>');}
  return;
 }
 beforeKyReportForm();
 const f=$('modal').querySelector('form'),submit=f.onsubmit;let saving=false;
 f.onsubmit=async function(e){
  e.preventDefault();if(saving)return;saving=true;const button=f.querySelector('.primary');button.disabled=true;
  try{
   if(await reportKyReadiness(sid)!=='ready'){notify('KYの記録または原本を確認できません。KYから原本を再登録してください。');return;}
   if(siteId!==sid||!f.isConnected||!$('modal').open){notify('画面が切り替わりました。対象現場で報告を開き直してください。');return;}
   return submit.call(this,e);
  }finally{saving=false;button.disabled=false;}
 };
};
ensureOperationsNavigation();render();
