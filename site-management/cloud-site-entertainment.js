(function(){'use strict';
const mounted=new WeakMap();let epoch=0;
const identity=()=>{const s=window.portalSession,a=s?.identity(),kind=a?.kind||'employee';return s?.connected()&&kind==='employee'&&a?.code?`${kind}:${a.code}`:''};
const make=(tag,text)=>{const x=document.createElement(tag);if(text!=null)x.textContent=String(text);return x};
const add=(parent,tag,text)=>{const x=make(tag,text);parent.append(x);return x};
const statusText={approved:'承認済み',pending:'承認待ち',on_hold:'保留'};
const yen=value=>value!=null&&value!==''&&Number.isFinite(Number(value))?`${new Intl.NumberFormat('ja-JP').format(Number(value))}円`:'金額未確認';
const receiptDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||''))?String(value).replace(/-/g,'/'):'領収書の日付未確認';
function mount({host,siteKey,onChanged}={}){
 const target=host?.matches?.('[data-site-entertainment]')?host:host?.querySelector?.('[data-site-entertainment]');if(!target||!siteKey)return;
 const previous=mounted.get(target);if(previous&&previous.siteKey===siteKey&&previous.owner===identity()&&previous.epoch===epoch)return previous;
 if(previous)previous.cancel();
 const state={target,siteKey,onChanged,owner:identity(),epoch,cancelled:false,loading:false,version:0,rows:[],totalCount:0,approvedCount:0,pendingCount:0,cursor:null,ready:false};
 mounted.set(target,state);target.replaceChildren();
 const current=()=>!state.cancelled&&mounted.get(target)===state&&target.isConnected&&state.owner===identity()&&state.epoch===epoch;
 add(target,'h3','この現場の接待経費');add(target,'p','経費申請でこの現場を選んだ接待交際費を自動表示します。').className='hint';
 const status=add(target,'p','本人と現場の権限を確認中…');status.setAttribute('role','status');
 const list=add(target,'div');list.dataset.entertainmentExpenses='';
 state.cancel=()=>{state.cancelled=true;state.version++;target.replaceChildren()};
 if(!state.owner){status.textContent='管理者として社員ポータルへログインしてから確認してください。';return state}
 const report=()=>{if(current()&&typeof onChanged==='function')onChanged({count:0,approvedCount:state.approvedCount,pendingCount:state.pendingCount,totalCount:state.totalCount,hasMore:state.cursor!=null,rows:state.rows.map(r=>({id:r.id,receiptDate:r.receiptDate,store:r.store,purpose:r.purpose,status:r.status,amount:r.amount}))})};
 const validPage=data=>data&&Array.isArray(data.rows)&&[data.totalCount,data.approvedCount,data.pendingCount].every(n=>Number.isSafeInteger(Number(n))&&Number(n)>=0)&&
  (data.nextBeforeId==null||Number.isSafeInteger(Number(data.nextBeforeId))&&Number(data.nextBeforeId)>0)&&
  data.rows.every(r=>r&&Number.isSafeInteger(Number(r.id))&&Number(r.id)>0&&Object.hasOwn(statusText,r.status));
 function notice(message,retry){if(!current())return;status.replaceChildren(document.createTextNode(message));if(retry){const b=make('button','もう一度確認する');b.type='button';b.className='secondary';b.onclick=retry;status.append(' ',b)}}
 function render(){if(!current())return;list.replaceChildren();if(!state.ready){add(list,'p',state.loading?'接待経費を確認中…':'経費件数は未確認です。');return}
  add(list,'p',`承認済み経費 ${state.approvedCount}件 ／ 承認待ち・保留 ${state.pendingCount}件（1回の接待に複数の経費明細がある場合があります）`);
  if(!state.rows.length)add(list,'p','この現場の接待経費はありません。');
  for(const r of state.rows){const row=add(list,'article');row.className='panel';add(row,'strong',`${receiptDate(r.receiptDate)} ／ ${r.store||'店名未確認'} ／ ${yen(r.amount)}`);
   add(row,'p',`${r.purpose||'用途詳細未記入'} ／ ${statusText[r.status]}`);if(r.partnerCompanies)add(row,'p',`取引先: ${r.partnerCompanies}`)}
  if(state.cursor!=null){const b=add(list,'button','経費をさらに表示');b.type='button';b.className='secondary';b.disabled=state.loading;b.onclick=()=>load(true)}
 }
 async function load(more=false){if(!current()||state.loading)return;const version=++state.version,before=more?state.cursor:null;state.loading=true;render();notice(more?'次の経費を確認中…':'接待経費を確認中…');
  try{const data=await portalSession.call('siteEntertainmentExpenses',{p_site_key:siteKey,p_before_id:before});if(!current()||version!==state.version)return;
   if(!validPage(data))throw Error('接待経費の返却形式を確認できません');
   state.rows=more?state.rows.concat(data.rows):data.rows;state.totalCount=Number(data.totalCount);state.approvedCount=Number(data.approvedCount);state.pendingCount=Number(data.pendingCount);state.cursor=data.nextBeforeId;state.ready=true;
   notice('');render();report()}
  catch(e){if(current()&&version===state.version)notice(`取得できませんでした：${e.message}`,()=>load(more))}
  finally{state.loading=false;if(current())render()}
 }
 load();return state;
}
window.mountSiteEntertainment=mount;
window.addEventListener('portal-session-ready',()=>{epoch++;document.querySelectorAll('[data-site-entertainment]').forEach(target=>{const state=mounted.get(target);if(state){state.cancel();mounted.delete(target)}})});
})();
