(function(){
'use strict';
const SYNC='jinshou-site-sync-v1',cache=new Map(),busy=new Map();
const labels={synced:'今月のシートに確認済み',conflict:'登録内容に違いあり',error:'反映できていません',pending:'今月のシートへの反映待ち',unconfigured:'今月の日報シートが未設定',stale:'最新の反映状況を確認できていません'};
function data(sid){try{return JSON.parse(localStorage.getItem(SYNC)||'{}')[sid]}catch{return null}}
function draw(sid){const el=document.getElementById('siteSheetStatus');if(!el||el.dataset.sid!==String(sid))return;const entry=cache.get(String(sid));el.innerHTML=`<h3>日報スプレッドシート</h3><p role="status">${esc(entry?.error||labels[entry?.value?.status]||'反映状況を確認中…')}</p>${entry?.value?`<p>${esc(entry.value.month)}${entry.value.row?' ／ 現場マスター '+esc(entry.value.row)+'行目':''}</p>${entry.value.checked_at?'<p>照合日時：'+esc(new Date(entry.value.checked_at).toLocaleString('ja-JP'))+'</p>':''}${entry.value.detail?'<p>'+esc(entry.value.detail)+'</p>':''}`:''}<button class="secondary" onclick="siteSheetRefresh('${sid}',true)" ${busy.has(String(sid))?'disabled':''}>照合記録を読み直す</button>${entry?.value&&['conflict','error','stale'].includes(entry.value.status)?`<button class="secondary" onclick="siteSheetRetry('${sid}')">シートを再照合する</button>`:''}<p class="muted">ポータル登録とシート反映は別の処理です。定期処理で照合した結果を表示します。</p>`}
window.siteSheetRefresh=(sid,force=false)=>{
 const id=String(sid),sync=data(id);if(!sync?.portalId)return Promise.resolve();
 if(busy.has(id))return busy.get(id);
 if(!force&&Date.now()-(cache.get(id)?.at||0)<60000){draw(id);return Promise.resolve()}
 const job=Promise.resolve().then(async()=>{try{
  if(!window.portalSession?.connected())throw Error('ポータルのログイン確認待ちです。確認後に自動で読み込みます。');
  const value=await portalSession.call('sheetStatus',{p_site_id:sync.portalId});
  if(!value||!labels[value.status])throw Error('反映状況を取得できませんでした');
  cache.set(id,{value,at:Date.now()});
 }catch(e){cache.set(id,{error:e.message||'反映状況を取得できませんでした',at:Date.now()})}finally{busy.delete(id);draw(id)}});
 busy.set(id,job);draw(id);return job;
};
window.siteSheetRetry=async sid=>{try{await portalSession.call('sheetRetry',{p_site_id:data(sid)?.portalId});await siteSheetRefresh(sid,true);notify('再照合を予約しました。次の日報反映時に確認します。')}catch(e){notify(e.message)}};
function mount(){if(page!=='detail'||tab!=='メンバー')return;const sid=String(siteId),sync=data(sid);if(!sync?.portalId)return;
 const heading=[...document.querySelectorAll('#app h2')].find(h=>h.textContent==='現場マスター連携');if(!heading)return;
 const panel=heading.closest('section');panel.innerHTML=`<h2>現場マスター連携</h2><p>ポータル登録済み ／ 現場ID：${esc(sync.portalId)}</p><div id="siteSheetStatus" data-sid="${esc(sid)}"></div>`;
 draw(sid);siteSheetRefresh(sid);
}
window.addEventListener('DOMContentLoaded',()=>{const previous=render;render=function(){previous();mount()};mount()});
window.addEventListener('portal-session-ready',()=>{if(page==='detail'&&tab==='メンバー')siteSheetRefresh(siteId,true)});
})();

