(function(){
'use strict';
const SYNC='jinshou-site-sync-v1',cache=new Map(),busy=new Map();let epoch=0;
const labels={synced:'今月のシートに確認済み',conflict:'登録内容に違いあり',error:'反映できていません',pending:'今月のシートへの反映待ち',unconfigured:'今月の日報シートが未設定',stale:'最新の反映状況を確認できていません'};
function data(sid){try{return JSON.parse(localStorage.getItem(SYNC)||'{}')[sid]}catch{return null}}
function portalId(sid){const snapshot=window.siteSharedProfilesSnapshot?.();const row=snapshot?.ready&&snapshot.rows.find(r=>String(r.localId)===String(sid));if(row)return row.portal_site_id||null;const site=state.sites.find(s=>String(s.id)===String(sid));return site&&!site.__sharedOnly?data(sid)?.portalId:null}
function draw(sid){const el=document.getElementById('siteSheetStatus');if(!el||el.dataset.sid!==String(sid))return;const entry=cache.get(String(sid));el.innerHTML=`<h3>日報スプレッドシート</h3><p role="status">${esc(entry?.error||labels[entry?.value?.status]||'反映状況を確認中…')}</p>${entry?.value?`<p>${esc(entry.value.month)}${entry.value.row?' ／ 現場マスター '+esc(entry.value.row)+'行目':''}</p>${entry.value.checked_at?'<p>照合日時：'+esc(new Date(entry.value.checked_at).toLocaleString('ja-JP'))+'</p>':''}${entry.value.detail?'<p>'+esc(entry.value.detail)+'</p>':''}`:''}<button class="secondary" onclick="siteSheetRefresh('${sid}',true)" ${busy.has(String(sid))?'disabled':''}>照合記録を読み直す</button>${entry?.value&&['conflict','error','stale'].includes(entry.value.status)?`<button class="secondary" onclick="siteSheetRetry('${sid}')">シートを再照合する</button>`:''}<p class="muted">ポータル登録とシート反映は別の処理です。定期処理で照合した結果を表示します。</p>`}
window.siteSheetRefresh=(sid,force=false)=>{
 const id=String(sid),portal=portalId(id);if(!portal)return Promise.resolve();
 if(busy.has(id))return busy.get(id);
 if(!force&&Date.now()-(cache.get(id)?.at||0)<60000){draw(id);return Promise.resolve()}
 const actor=JSON.stringify(portalSession.identity()),requestEpoch=epoch;const job=Promise.resolve().then(async()=>{try{
  if(!window.portalSession?.connected())throw Error('ポータルのログイン確認待ちです。確認後に自動で読み込みます。');
  const value=await portalSession.call('sheetStatus',{p_site_id:portal});if(requestEpoch!==epoch||actor!==JSON.stringify(portalSession.identity())||portal!==portalId(id))return;
  if(!value||!labels[value.status])throw Error('反映状況を取得できませんでした');
  cache.set(id,{value,at:Date.now()});
 }catch(e){if(requestEpoch===epoch&&actor===JSON.stringify(portalSession.identity()))cache.set(id,{error:e.message||'反映状況を取得できませんでした',at:Date.now()})}finally{if(busy.get(id)===job)busy.delete(id);if(requestEpoch===epoch&&actor===JSON.stringify(portalSession.identity()))draw(id)}});
 busy.set(id,job);draw(id);return job;
};
window.siteSheetRetry=async sid=>{try{const portal=portalId(sid);if(!portal)throw Error('ポータル現場IDを確認できません');await portalSession.call('sheetRetry',{p_site_id:portal});await siteSheetRefresh(sid,true);notify('再照合を予約しました。次の日報反映時に確認します。')}catch(e){notify(e.message)}};
function mount(){if(page!=='detail'||tab!=='メンバー')return;const sid=String(siteId),portal=portalId(sid);if(!portal)return;
 const heading=[...document.querySelectorAll('#app h2')].find(h=>h.textContent==='現場マスター連携');if(!heading)return;
 const panel=heading.closest('section');panel.innerHTML=`<h2>現場マスター連携</h2><p>ポータル登録済み ／ 現場ID：${esc(portal)}</p><div id="siteSheetStatus" data-sid="${esc(sid)}"></div>`;
 draw(sid);siteSheetRefresh(sid);
}
window.addEventListener('DOMContentLoaded',()=>{const previous=render;render=function(){previous();mount()};mount()});
window.addEventListener('portal-session-ready',()=>{epoch++;cache.clear();busy.clear();if(page==='detail'&&tab==='メンバー')siteSheetRefresh(siteId,true)});
})();

