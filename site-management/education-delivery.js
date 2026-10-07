(function(){
'use strict';
const PLAN='jinshou-site-education-plans-v1',KEYS='jinshou-site-education-keys-v1';let refreshId=0,sessionEpoch=0;const recent=new Map(),statusReads=new Map(),printWindows=new Set();
function printConfirmation(record,signature,siteName,expectedActor,expectedEpoch){
 if(!portalSession.connected()||JSON.stringify(portalSession.identity())!==expectedActor||sessionEpoch!==expectedEpoch){notify('ログインが変わりました。確認記録を開き直してください。');return}
 if(!record.signed_at||typeof signature!=='string'||signature.length>400000||!/^data:image\/png;base64,[A-Za-z0-9+/=\s]+$/.test(signature)){notify('本人確認記録を読み直してください。');return}
 const win=window.open('about:blank','_blank');if(!win){notify('印刷用画面を開けませんでした。このサイトの別画面表示を許可して再度お試しください。');return}
 printWindows.add(win);
 const html='<!doctype html><html lang="ja"><meta charset="utf-8"><title>安全教育 本人確認記録</title><style>@page{size:A4 portrait;margin:15mm}*{box-sizing:border-box}body{margin:0;color:#17304f;font:11pt/1.6 Meiryo,sans-serif}main{max-width:180mm;margin:0 auto}h1{font-size:20pt;margin:8mm 0}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{border:1px solid #a9b7c5;padding:3mm;text-align:left;overflow-wrap:anywhere}th{width:32mm;background:#f2f5f8}tr,.signature{break-inside:avoid}.signature{border:1px solid #a9b7c5;margin-top:6mm;padding:4mm}.signature h2{font-size:12pt;margin:0 0 2mm}.signature img{display:block;max-width:100%;width:150mm;height:60mm;object-fit:contain;object-position:left center}.test{border:2px solid #a87916;padding:3mm}small{display:block;margin-top:4mm;font-size:9pt;overflow-wrap:anywhere}.controls{padding:4mm;background:#f2f5f8}button{font:inherit;padding:2mm 4mm}@media print{.controls{display:none}}</style><div class="controls"><button onclick="window.print()">印刷・PDF保存</button></div><main><h1>安全教育 本人確認記録</h1>'+(record.test_only?'<p class="test">動作テストの記録です。実際の現場教育の受講記録ではありません。</p>':'')+'<table><tr><th>現場</th><td>'+esc(siteName)+'</td></tr><tr><th>確認した本人</th><td>'+esc(record.name)+'<br>'+esc(record.recipient_type==='worker'?'協力会社個人 ID：':'社員コード：')+esc(record.employee_code)+'</td></tr><tr><th>教材・版</th><td>'+esc(record.title)+'<br>'+esc(record.version)+'</td></tr><tr><th>教育担当・実施日</th><td>'+esc(record.instructor_name||'未指定')+' ／ '+esc(record.education_date||'未記録')+'</td></tr><tr><th>本人確認日時</th><td>'+esc(new Date(record.signed_at).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}))+'（日本時間）</td></tr></table><section class="signature"><h2>本人が送信したサイン</h2><img alt="本人が送信したサイン" src="'+esc(signature)+'"></section><small>ポータルの保存済み本人確認記録から出力しています。担当者による説明記録とは別の記録です。<br>配信記録 ID：'+esc(record.id)+'</small></main></html>';
 win.document.open();win.document.write(html);win.document.close();win.focus();
}
function closePrintWindows(){for(const win of printWindows){try{win.close()}catch{}}printWindows.clear()}
window.addEventListener('pagehide',closePrintWindows);
const read=k=>JSON.parse(localStorage.getItem(k)||'{}');
function key(sid){return sitePortalSiteKey(sid)}
function targets(sid){return siteResolvedMembers(sid).filter(p=>['employee','worker'].includes(p.type)&&p.view&&p.educationTarget&&!p.sample&&!String(p.id).startsWith('DEMO-'))}
async function workerStatus(site){const owner=JSON.stringify(portalSession.identity()),epoch=sessionEpoch;const rows=[];let after=null;for(let page=0;page<100;page++){const batch=await portalSession.call('workerEducationStatus',{p_site_key:site,p_after_id:after});if(!portalSession.connected()||owner!==JSON.stringify(portalSession.identity())||epoch!==sessionEpoch)throw Error('ログインが変わりました');rows.push(...batch);if(batch.length<100)return rows;const next=batch.at(-1).id;if(!next||(after&&next<=after))throw Error('受講状況の続きを取得できません');after=next;}throw Error('受講状況が多すぎます。表示範囲を絞ってください');}
function statusRows(site){const owner=JSON.stringify(portalSession.identity()),epoch=sessionEpoch,k=JSON.stringify([owner,epoch,site]);if(statusReads.has(k))return statusReads.get(k);const valid=()=>portalSession.connected()&&owner===JSON.stringify(portalSession.identity())&&epoch===sessionEpoch;const job=Promise.resolve().then(async()=>{if(!valid())throw Error('ログインが変わりました');const employeeRows=await sitePortal.educationStatus(site);if(!valid())throw Error('ログインが変わりました');const workerRows=await workerStatus(site);if(!valid())throw Error('ログインが変わりました');return [employeeRows,workerRows]}).finally(()=>{if(statusReads.get(k)===job)statusReads.delete(k)});statusReads.set(k,job);return job}
const planReads=new Map();
const samePerson=(r,p)=>r.recipient_type===p.type&&String(r.employee_code)===String(p.id);
function trainingState(person,rows,plan){
 if(!plan)return {label:'現場教材を確認できません',sendable:false};
 const mine=rows.filter(r=>samePerson(r,person));
 const current=mine.filter(r=>r.document_key===plan.documentId&&r.document_hash===plan.hash&&r.version===plan.version&&!r.test_only);
 if(current.some(r=>r.signed_at))return {label:'受講済み（現行教材・本人サイン）',sendable:false};
 if(current.length)return {label:'配信済み・本人サイン待ち',sendable:false};
 if(mine.some(r=>r.document_key===plan.documentId))return {label:'同じ教材IDの旧版またはテスト配信があります。新しい教材として登録してください',sendable:false};
 if(mine.some(r=>r.signed_at&&!r.test_only))return {label:'現行教材は未配信（以前の教材は受講済み）',sendable:true};
 if(mine.some(r=>r.test_only))return {label:'現行教材は未配信（テスト記録は受講済みに含みません）',sendable:true};
 return {label:'現行教材は未配信',sendable:true};
}
async function currentPlan(sid){
 const actor=JSON.stringify(portalSession.identity()),epoch=sessionEpoch,shared=await siteEducationShared.read(sid);
 if(!portalSession.connected()||actor!==JSON.stringify(portalSession.identity())||epoch!==sessionEpoch)throw Error('ログインが変わりました');
 const plan=shared.plan?.payload;
 if(!plan?.enabled||!plan.documentId)return null;
 const doc=shared.docs.find(x=>x.id===plan.documentId&&x.payload?.state==='ready');
 if(!doc)throw Error('現行教材の原本を確認できません');
 let sourceIdentity=[doc.revision,doc.payload.fileRecordId,doc.payload.libraryId];
 if(doc.payload.libraryId){
  const row=(await siteCompanyEducationLibrary.list(shared.key)).find(x=>String(x.id)===String(doc.payload.libraryId));
  if(!portalSession.connected()||actor!==JSON.stringify(portalSession.identity())||epoch!==sessionEpoch)throw Error('ログインが変わりました');
  if(!row||row.attachment_id&&row.attachment_state!=='ready')throw Error('現行教材の原本を確認できません');
  sourceIdentity.push(row.id,row.revision,row.attachment_id,row.attachment_state,row.version);
 }
 const cacheKey=JSON.stringify([actor,epoch,shared.key,shared.plan?.revision,plan.documentId,plan.version,sourceIdentity]);
 if(planReads.has(cacheKey))return planReads.get(cacheKey);
 const job=(async()=>{
  const blob=await siteEducationShared.blob(sid,plan.documentId);
  if(!portalSession.connected()||actor!==JSON.stringify(portalSession.identity())||epoch!==sessionEpoch)throw Error('ログインが変わりました');
  if(!(blob instanceof Blob)||!['application/pdf','image/png','image/jpeg'].includes(blob.type)||blob.size<1||blob.size>10*1024*1024)
   throw Error('配信教材は10MB以内のPDF・PNG・JPEGを選んでください');
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');
  if(!portalSession.connected()||actor!==JSON.stringify(portalSession.identity())||epoch!==sessionEpoch)throw Error('ログインが変わりました');
  return {documentId:plan.documentId,version:plan.version,name:plan.name,hash,blob};
 })().catch(e=>{if(planReads.get(cacheKey)===job)planReads.delete(cacheKey);throw e});
 planReads.set(cacheKey,job);return job;
}
window.siteEducationRefresh=async sid=>{
 const id=++refreshId,actor=JSON.stringify(portalSession.identity()),epoch=sessionEpoch,el=$('educationServerStatus');if(!el)return;
 if(!sitePortal.connected()){el.innerHTML='<p>受講記録を読み込めていません。未受講という意味ではありません。</p><button class="secondary" id="educationRetry">ログイン確認画面を開く</button>';el.querySelector('button').onclick=()=>portalSession.open();return}
 if(!el.querySelector('table'))el.textContent='受講状況を確認中…';
 try{
  const [[employeeRows,workerRows],planResult]=await Promise.all([statusRows(key(sid)),currentPlan(sid).then(plan=>({plan}),error=>({error}))]);
  await siteMembersRefresh(sid);
  if(id!==refreshId||epoch!==sessionEpoch||!el.isConnected||actor!==JSON.stringify(portalSession.identity()))return;
  const rows=[...employeeRows.map(r=>({...r,recipient_type:'employee'})),...workerRows.map(r=>({...r,recipient_type:'worker',employee_code:String(r.worker_id)}))];
  recent.set(String(sid),rows);
  const plan=planResult.plan,people=targets(sid),personRows=people.map(p=>({person:p,state:trainingState(p,rows,plan)}));
  const active=planResult.error?`<p>現行教材を確認できません（未受講という意味ではありません）：${esc(planResult.error.message)}</p>`:plan?`<p><strong>現行教材：</strong>${esc(plan.name)} ／ ${esc(plan.version)}</p>`:'<p>現行教材は未設定または配信停止中です。受講済みを判定できません。</p>';
  const currentTable=personRows.length?`<table class="table"><thead><tr><th>教育対象者</th><th>入場予定</th><th>現行教材の受講状況</th></tr></thead><tbody>${personRows.map(({person:p,state})=>`<tr><td>${esc(p.name)} ／ ${esc(p.company||'')}<br>${esc(p.type==='worker'?'外注個人 '+p.id:'社員 '+p.id)}</td><td>${esc(p.entryDate||'未設定')}</td><td>${esc(state.label)}</td></tr>`).join('')}</tbody></table>`:'<p>この現場の教育対象者は登録されていません。</p>';
  const history=rows.length?`<details><summary>過去の配信・本人サイン記録（${rows.length}件）</summary><table class="table"><thead><tr><th>対象者</th><th>教材・版</th><th>教育担当・実施日</th><th>確認状態</th><th>確認日時</th></tr></thead><tbody>${rows.map((r,i)=>`<tr><td>${esc(r.name)}<br>${esc(r.employee_code)}</td><td>${esc(r.title)}<br>${esc(r.version)}</td><td>${esc(r.instructor_name||'未指定（以前の記録）')}<br>${esc(r.education_date||'—')}</td><td>${r.test_only?'【テスト】 ':''}${r.signed_at?'本人サイン済み':r.opened_at?'書類を閲覧・サイン待ち':'配信済み・未確認'}${r.signed_at?`<br><button class="secondary" data-signature="${i}">サインを見る</button>`:''}</td><td>${r.signed_at?esc(new Date(r.signed_at).toLocaleString('ja-JP')):'—'}</td></tr>`).join('')}</tbody></table></details>`:'<p>配信履歴はありません。</p>';
  el.innerHTML=active+currentTable+history+'<p>受講状況は15秒ごとに更新されます。教材の版を変えた場合は新しい教材として登録してください。</p>';
  el.querySelectorAll('[data-signature]').forEach(b=>b.onclick=async()=>{const r=rows[Number(b.dataset.signature)];b.disabled=true;try{const signature=r.recipient_type==='worker'?(await portalSession.call('workerEducationSignature',{p_id:r.id})).signature_png:r.signature_png;if(id!==refreshId||epoch!==sessionEpoch||!el.isConnected||actor!==JSON.stringify(portalSession.identity()))return;show(`<h2>${esc(r.name)}の確認記録</h2><p>${esc(r.title)} ／ ${esc(r.version)}</p><p>${esc(new Date(r.signed_at).toLocaleString('ja-JP'))}${r.test_only?' ／ テスト':''}</p><img id="educationSignature" alt="本人が送信したサイン" style="max-width:100%;background:white"><div class="modalfoot"><button type="button" class="primary" id="educationSignaturePrint">確認記録を印刷・PDF保存</button><button class="secondary" onclick="closeModal()">閉じる</button></div>`);$('educationSignature').src=signature;const printActor=actor,printEpoch=sessionEpoch,printSite=state.sites.find(x=>String(x.id)===String(sid))?.name||'現場';$('educationSignaturePrint').onclick=()=>printConfirmation(r,signature,printSite,printActor,printEpoch)}catch(e){if(el.isConnected)notify(e.message)}finally{b.disabled=false}});
 }catch(e){if(id===refreshId&&epoch===sessionEpoch&&el.isConnected)el.textContent='受講状況を確認できません（未受講という意味ではありません）：'+e.message}
};
window.siteEducationSend=async sid=>{
 if(!sitePortal.connected()){notify('ポータルにログインしてください。');return}
 const actor=JSON.stringify(portalSession.identity()),epoch=sessionEpoch,valid=()=>sitePortal.connected()&&actor===JSON.stringify(portalSession.identity())&&epoch===sessionEpoch;
 let plan,people,rows,teachers;
 try{
  if(!siteSharedStore.access(key(sid),'安全教育')?.manage)throw Error('この現場の教育管理権限が必要です');
  await siteMembersRefresh(sid);
  let employeeRows,workerRows;
  [plan,[employeeRows,workerRows],teachers]=await Promise.all([currentPlan(sid),statusRows(key(sid)),sitePortal.educationInstructors(key(sid))]);
  rows=[...employeeRows.map(r=>({...r,recipient_type:'employee'})),...workerRows.map(r=>({...r,recipient_type:'worker',employee_code:String(r.worker_id)}))];
  if(!valid())return;people=targets(sid);
 }catch(e){if(valid())notify('配信先を確認できません。再読込してください：'+e.message);return}
 if(!plan){show('<h2>教材を設定してください</h2><p>安全教育で教材を選び、現行教材として設定してください。</p><button class="secondary" onclick="closeModal()">戻る</button>');return}
 const options=people.map(p=>({person:p,state:trainingState(p,rows,plan)})),sendable=options.filter(x=>x.state.sendable);
 show(`<h2>安全教育をポータルに配信</h2><p>${esc(plan.name)} ／ ${esc(plan.version)}</p><p>同じ教材を配信済みの方には通知を重複させません。テスト記録は正式な受講済みに含めません。</p><form id="educationSend"><label>今回の配信先<select name="employee" required><option value="">選択してください</option>${sendable.map(({person:p})=>`<option value="${esc(p.type+':'+p.id)}">${esc(p.name)} ／ ${esc(p.company||'')} ／ ${esc(p.id)}</option>`).join('')}</select></label>${!sendable.length?'<p>現行教材を新たに配信できる対象者はいません。配信済み・サイン待ちの方は本人ポータルで確認してください。</p>':''}<label>今回の教育担当者<select name="instructor" required><option value="">選択してください</option>${teachers.map(t=>`<option value="${esc(t.code)}">${esc(t.name)}</option>`).join('')}</select></label><label>教育実施日<input name="educationDate" type="date" value="${new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'})}" required></label><label><input type="checkbox" name="test"> 動作テストとして配信する（正式な受講にはなりません）</label><p>同じ教材IDでテスト配信した後は本番配信へ切り替えられません。正式配信には新しい教材として登録してください。</p><p id="educationSendError" role="status"></p>${foot('この人に配信する')}</form>`);
 const form=$('educationSend');if(!sendable.length)form.querySelector('.primary').disabled=true;
 form.onsubmit=async e=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('.primary');if(b.disabled)return;b.disabled=true;
  try{
   if(!valid())throw Error('ログインが変わりました');
   const selected=sendable.find(({person:p})=>p.type+':'+p.id===f.elements.employee.value)?.person;
   if(!selected)throw Error('対象者を選択してください');
   const [latest,[employeeRows,workerRows]]=await Promise.all([currentPlan(sid),statusRows(key(sid))]);
   if(!valid()||!f.isConnected)throw Error('ログインまたは画面が変わりました');
   if(!latest||latest.documentId!==plan.documentId||latest.hash!==plan.hash||latest.version!==plan.version)throw Error('現行教材が変わりました。読み直してください');
   const latestRows=[...employeeRows.map(r=>({...r,recipient_type:'employee'})),...workerRows.map(r=>({...r,recipient_type:'worker',employee_code:String(r.worker_id)}))];
   if(!targets(sid).some(p=>p.type===selected.type&&String(p.id)===String(selected.id))||!trainingState(selected,latestRows,latest).sendable)throw Error('配信先の状態が変わりました。読み直してください');
   const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(latest.blob)});
   if(!valid()||!f.isConnected)throw Error('ログインまたは画面が変わりました');
   const payload={site_key:key(sid),site_name:state.sites.find(s=>String(s.id)===String(sid))?.name||'現場',document_key:latest.documentId,
    title:latest.name,version:latest.version,mime:latest.blob.type,document_base64:base64,
    employee_code:selected.type==='employee'?selected.id:undefined,worker_id:selected.type==='worker'?selected.id:undefined,
    instructor_code:f.elements.instructor.value,education_date:f.elements.educationDate.value,test_only:f.elements.test.checked};
   const publish=selected.type==='worker'?p=>portalSession.call('workerEducationPublish',{p_payload:p}):p=>sitePortal.educationPublish(p);
   await publish(payload);if(!valid()||!f.isConnected)return;closeModal();await siteEducationRefresh(sid);
  }catch(err){if(f.isConnected&&valid())$('educationSendError').textContent=err.message}finally{if(f.isConnected)b.disabled=false}
 };
};

window.addEventListener('portal-session-ready',()=>{refreshId++;sessionEpoch++;statusReads.clear();planReads.clear();closePrintWindows();recent.clear();if($('educationServerStatus'))$('educationServerStatus').replaceChildren();if($('educationServerStatus'))siteEducationRefresh(siteId)});
window.addEventListener('DOMContentLoaded',()=>{const prior=render;render=function(){prior();const panel=$('educationDeliveryPanel');if(!panel)return;
panel.querySelector('h2').textContent='安全教育の配信・受講一覧';
panel.querySelector('.notice').textContent='担当者はここで教材を配信し、受講状況と本人のサインを確認します。受講者は自分のポータルに届くお知らせから教材を確認してサインします。';
panel.querySelector('table')?.remove();
panel.insertAdjacentHTML('beforeend',`<div class="row"><button class="primary" id="sendEducation">対象者を選んで教材を配信</button><button class="secondary" id="refreshEducation">受講状況を更新</button></div><div id="educationServerStatus" role="status" style="margin-top:20px;overflow:auto"></div>`);
const sid=siteId;$('sendEducation').onclick=()=>siteEducationSend(sid);$('refreshEducation').onclick=()=>siteEducationRefresh(sid);
if(tab==='安全教育'){document.querySelector('#app .tabs')?.after(panel);const old=$('educationStatus')?.closest('section');if(old){old.querySelector('h2').textContent='対面教育の記録';old.querySelector('button').textContent='対面教育の記録を確認';old.insertAdjacentHTML('afterbegin','<p>ポータルで受け取ったサインは、上の「配信・受講一覧」で確認します。下の対面教育記録とは別の記録です。</p>')}}
siteEducationRefresh(sid)};render();setInterval(()=>{if(!document.hidden&&$('educationServerStatus')&&sitePortal.connected())siteEducationRefresh(siteId)},15000)});
const demoStates=['受講済み','受講済み','サイン待ち','未確認','未配信','未配信'];
function renderEducationExamples(){const el=$('educationDemoRows');if(!el)return;el.innerHTML=`<table class="table"><thead><tr><th>対象者（架空）</th><th>所属</th><th>状態</th><th>確認・操作</th></tr></thead><tbody>${['山田 太郎','佐藤 花子','鈴木 一郎','田中 健','高橋 翔','伊藤 誠'].map((n,i)=>`<tr><td>【見本】${n}</td><td>テスト会社</td><td><strong>${demoStates[i]}</strong></td><td><button class="secondary" data-demo="${i}">${demoStates[i]==='受講済み'?'確認記録の見本':'受講者側の画面を試す'}</button></td></tr>`).join('')}</tbody></table>`;el.querySelectorAll('[data-demo]').forEach(b=>b.onclick=()=>{const i=Number(b.dataset.demo);show(`<h2>受講者側の画面【架空の操作テスト】</h2><p>実際には本人のポータルのお知らせからこの流れで開きます。</p><h3>現場の安全教育</h3><div class="panel"><strong>教材の見本</strong><p>現場の入口・集合場所、危険箇所、緊急時の連絡先を確認します。</p></div>${demoStates[i]==='受講済み'?'<p>教材確認・サイン送信済みの表示例です。実際の本人サインは含みません。</p>':'<label><input id="demoRead" type="checkbox">教材の内容を確認しました（テスト）</label><button id="demoComplete" class="primary" disabled>サイン送信後の反映を試す</button><p>この操作はサインそのものを代筆・保存するものではありません。</p>'}<button class="secondary" onclick="closeModal()">閉じる</button>`);if($('demoRead')){$('demoRead').onchange=e=>$('demoComplete').disabled=!e.target.checked;$('demoComplete').onclick=()=>{demoStates[i]='受講済み';closeModal();renderEducationExamples();notify('架空の見本だけを受講済みにしました。実際の記録は変更していません。')}}})}
})();
