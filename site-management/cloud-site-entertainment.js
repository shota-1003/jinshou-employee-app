(function(){'use strict';
const mounted=new WeakMap();let epoch=0;
const identity=()=>{const s=window.portalSession,a=s?.identity(),kind=a?.kind||'employee';return s?.connected()&&kind==='employee'&&a?.code?`${kind}:${a.code}`:''};
const make=(tag,text)=>{const x=document.createElement(tag);if(text!=null)x.textContent=String(text);return x};
const add=(parent,tag,text)=>{const x=make(tag,text);parent.append(x);return x};
const thisMonth=()=>{const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit'}).formatToParts(new Date());return `${parts.find(x=>x.type==='year').value}-${parts.find(x=>x.type==='month').value}`};
const plannedAt=value=>{if(!value)return '予定日時未設定';const d=new Date(value);return Number.isNaN(d.getTime())?'予定日時未確認':new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(d)+'（予定）'};
const statusText={pending:'申請中',approved:'承認済み',rejected:'却下'};
function mount({host,siteKey,localId,onChanged}={}){
 const target=host?.matches?.('[data-site-entertainment]')?host:host?.querySelector?.('[data-site-entertainment]');if(!target||!siteKey)return;
 const previous=mounted.get(target);if(previous&&previous.siteKey===siteKey&&previous.owner===identity()&&previous.epoch===epoch)return previous;
 if(previous)previous.cancel();
 const state={target,siteKey,localId,onChanged,owner:identity(),epoch,cancelled:false,busy:false,pending:null,conflict:false,readVersion:0,candidateSeq:0,
  linked:[],linkedTotal:0,linkedCursor:null,linkedLoading:false,linkedReady:false,candidates:[],candidateTotal:0,candidateCursor:null,candidateLoading:false,candidateReady:false,month:thisMonth()};
 mounted.set(target,state);target.replaceChildren();
 const current=()=>!state.cancelled&&mounted.get(target)===state&&target.isConnected&&state.owner===identity()&&state.epoch===epoch;
 add(target,'h3','ポータルの接待（予定・申請）');add(target,'p','管理者が接待申請の正本を明示して関連付けます。予定・承認は実施の記録ではありません。').className='hint';
 const status=add(target,'p','本人と現場の権限を確認中…');status.setAttribute('role','status');
 const linkedBox=add(target,'div');linkedBox.dataset.entertainmentLinked='';
 const chooser=add(target,'section');chooser.dataset.entertainmentChooser='';
 state.cancel=()=>{state.cancelled=true;state.pending=null;target.replaceChildren()};
 if(!state.owner){status.textContent='管理者として社員ポータルへログインしてから確認してください。';return state}
 const report=()=>{if(current()&&typeof onChanged==='function')onChanged({count:0,linkedCount:state.linkedTotal,hasMore:state.linkedCursor!=null,rows:state.linked.map(r=>({id:r.id,plannedAt:r.plannedAt,store:r.store,purpose:r.purpose,status:r.status,execution:'unconfirmed'}))})};
 const validPage=data=>data&&Array.isArray(data.rows)&&Number.isSafeInteger(Number(data.totalCount))&&Number(data.totalCount)>=0&&
  (data.nextBeforeId==null||Number.isSafeInteger(Number(data.nextBeforeId))&&Number(data.nextBeforeId)>0);
 const notice=(message,actions=[])=>{if(!current())return;status.replaceChildren(document.createTextNode(message));for(const [label,run] of actions){const b=make('button',label);b.type='button';b.className='secondary';b.onclick=run;status.append(' ',b)}};
 function renderLinked(){if(!current())return;linkedBox.replaceChildren();if(!state.linkedReady){add(linkedBox,'p','関連付け件数は未確認です。');return}add(linkedBox,'p',`関連付け済み ${state.linkedTotal}件（実施件数には含めません）`);
  if(!state.linked.length)add(linkedBox,'p','この現場に関連付けた接待申請はありません。');
  for(const r of state.linked){const row=add(linkedBox,'article');row.className='panel';add(row,'strong',`${plannedAt(r.plannedAt)} ／ ${r.store||'店舗未記入'}`);
   add(row,'p',`${r.purpose||'目的未記入'} ／ ${statusText[r.status]||r.status||'状態未確認'}`);
   if(r.partnerCompanies)add(row,'p',`取引先: ${r.partnerCompanies}`);
   add(row,'p',`領収書の紐付き ${Number(r.linkedReceiptCount||0)}件。現場での実施確認とは別です。`);
   const b=add(row,'button','この現場との関連付けを解除');b.type='button';b.className='secondary';b.disabled=state.busy||state.linkedLoading||state.candidateLoading||!!state.pending;b.onclick=()=>save(r,false)}
  if(state.linkedCursor!=null){const b=add(linkedBox,'button','関連付け済みをさらに表示');b.type='button';b.className='secondary';b.disabled=state.linkedLoading||state.busy;b.onclick=()=>loadLinked(true)}
 }
 function renderCandidates(){if(!current())return;chooser.replaceChildren();const controls=add(chooser,'div');controls.className='row';const label=add(controls,'label','申請予定月 '),month=add(label,'input');month.type='month';month.value=state.month;month.setAttribute('aria-label','接待申請の予定月');
  const refresh=add(controls,'button','この月の申請を探す');refresh.type='button';refresh.className='secondary';refresh.disabled=state.busy;refresh.onclick=()=>{state.month=month.value;loadCandidates(false)};
  if(!state.candidateReady){add(chooser,'p',state.candidateLoading?'この月の申請を確認中…':'候補件数は未確認です。');return}
  add(chooser,'p',`この月の選択可能な申請 ${state.candidateTotal}件`);
  if(!state.candidates.length)add(chooser,'p','この月に選べる接待申請はありません。');
  for(const r of state.candidates){const row=add(chooser,'div');row.className='row';add(row,'span',`#${r.id} ／ ${plannedAt(r.plannedAt)} ／ ${r.store||'店舗未記入'} ／ ${r.purpose||'目的未記入'} ／ ${statusText[r.status]||r.status||'状態未確認'}`);
   const b=add(row,'button',r.linkActive?'この現場に関連付け済み':'この現場に関連付ける');b.type='button';b.className='secondary';b.disabled=state.busy||state.linkedLoading||state.candidateLoading||!!state.pending||!!r.linkActive;b.onclick=()=>save(r,true)}
  if(state.candidateCursor!=null){const b=add(chooser,'button','この月の申請をさらに表示');b.type='button';b.className='secondary';b.disabled=state.candidateLoading||state.busy;b.onclick=()=>loadCandidates(true)}
 }
 async function loadLinked(more=false){if(!current()||state.linkedLoading||state.busy)return false;const version=++state.readVersion,before=more?state.linkedCursor:null;
  if(!more){state.linked=[];state.linkedTotal=0;state.linkedCursor=null;state.linkedReady=false}state.linkedLoading=true;renderLinked();renderCandidates();
  try{const data=await portalSession.call('siteEntertainmentRead',{p_site_key:siteKey,p_before_id:before});if(!current()||version!==state.readVersion)return false;if(!validPage(data))throw Error('接待申請の返却形式を確認できません');
   state.linked=more?state.linked.concat(data.rows):data.rows;state.linkedTotal=Number(data.totalCount);state.linkedCursor=data.nextBeforeId;state.linkedReady=true;
   notice('接待申請との関連付けを表示しました。');renderLinked();report();return true}
  catch(e){if(current()&&version===state.readVersion)notice(`取得できませんでした：${e.message}`,[['もう一度確認する',()=>loadLinked(false)]]);return false}
  finally{state.linkedLoading=false;if(current()){renderLinked();renderCandidates()}}}
 async function loadCandidates(more=false){if(!current()||state.busy)return;const period=state.month;
  if(!/^20\d\d-(0[1-9]|1[0-2])$/.test(period)){notice('予定月を確認してください。');return}
  const version=state.readVersion,seq=++state.candidateSeq,before=more?state.candidateCursor:null;
  if(!more){state.candidates=[];state.candidateTotal=0;state.candidateCursor=null;state.candidateReady=false}state.candidateLoading=true;renderLinked();renderCandidates();
  try{const data=await portalSession.call('siteEntertainmentCandidates',{p_site_key:siteKey,p_month:period,p_before_id:before});if(!current()||version!==state.readVersion||seq!==state.candidateSeq||period!==state.month)return;
   if(!validPage(data))throw Error('接待候補の返却形式を確認できません');state.candidates=more?state.candidates.concat(data.rows):data.rows;
   state.candidateTotal=Number(data.totalCount);state.candidateCursor=data.nextBeforeId;state.candidateReady=true;notice(`${period} の申請候補を確認しました。`);renderCandidates();if(state.conflict)showConflict();else if(state.pending)showPending()}
  catch(e){if(current()&&version===state.readVersion&&seq===state.candidateSeq)notice(`候補を取得できませんでした：${e.message}`,[['もう一度確認する',()=>loadCandidates(false)]])}
  finally{if(seq===state.candidateSeq){state.candidateLoading=false;if(current()){renderLinked();renderCandidates()}}}}
 function showConflict(){if(!current()||!state.conflict||!state.pending)return;const p=state.pending,latest=state.linked.find(x=>Number(x.id)===Number(p.p_preapproval_id));
  const now=state.linkedReady?(latest?`この現場に関連付け済み・第${latest.linkRevision}版`:'この現場への関連付けなし'):'最新版は未確認';
  const proposed=p.p_active?'関連付ける':'解除する';const actions=[['最新を読み直す',reload]];
  if(state.linkedReady)actions.push(['今回の操作を取りやめて最新版から選び直す',()=>{state.pending=null;state.conflict=false;notice('前回の操作を取りやめました。最新版から選び直してください。');renderLinked();renderCandidates()}]);
  notice(`保存時の第${p.p_expected_revision}版から「${proposed}」操作は競合しました。現在：${now}。内容を比較して選び直してください。`,actions)}
 function showPending(){if(current()&&state.pending&&!state.conflict)notice('先の保存応答が確認できません。同じ送信IDで結果を再確認してください。',[['同じ送信IDで再確認',retry],['最新を読み直す',reload]])}
 async function reload(){if(!current()||state.busy)return false;state.readVersion++;state.candidateSeq++;const ok=await loadLinked(false);if(ok&&current())await loadCandidates(false);if(state.conflict)showConflict();else if(state.pending)showPending();return ok}
 async function save(row,active){if(!current()||state.busy||state.linkedLoading||state.candidateLoading)return;
  if(!state.pending){state.pending={p_site_key:siteKey,p_preapproval_id:row.id,p_expected_revision:Number(row.linkRevision||0),p_request_id:crypto.randomUUID(),p_active:active}}
  else if(state.pending.p_preapproval_id!==row.id||state.pending.p_active!==active){notice('先の送信結果を確認してから操作してください。',[['同じ送信を再確認',retry],['最新を読み直す',reload]]);return}
  state.busy=true;state.readVersion++;state.candidateSeq++;state.linkedReady=false;state.candidateReady=false;renderLinked();renderCandidates();notice('同じ送信IDで関連付けを保存中…');
  try{await portalSession.call('siteEntertainmentLinkSave',state.pending);if(!current())return;state.pending=null;state.busy=false;
   const ok=await loadLinked(false);if(ok&&current()){notice('関連付けを保存しました。予定・承認は実施記録に数えていません。');await loadCandidates(false)}}
  catch(e){if(current()){state.busy=false;if(String(e.message).includes('接待リンクが更新されています')||String(e.message).includes('CONFLICT')){state.conflict=true;await reload();showConflict()}
    else notice(`保存結果を確認できません：${e.message}`, [['同じ送信IDで再確認',retry],['最新を読み直す',reload]])}}
  finally{state.busy=false;if(current()){renderLinked();renderCandidates()}}}
 function retry(){if(!current()||!state.pending||state.busy)return;save({id:state.pending.p_preapproval_id,linkRevision:state.pending.p_expected_revision},state.pending.p_active)}
 loadLinked(false).then(ok=>{if(ok&&current())loadCandidates(false)});return state;
}
window.mountSiteEntertainment=mount;
window.addEventListener('portal-session-ready',()=>{epoch++;document.querySelectorAll('[data-site-entertainment]').forEach(target=>{const state=mounted.get(target);if(state){state.cancel();mounted.delete(target)}})});
})();
