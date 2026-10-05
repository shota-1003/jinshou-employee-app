(function(root){'use strict';
 const escapeText=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const today=()=>new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'});
 const actorId=person=>JSON.stringify([person?.kind||'employee',person?.code||'',person?.worker_id||'',person?.company_id||person?.companyId||'',person?.authEpoch||'']);
 let generation=0,active=null;
 root.mountSiteKyInbox=async function(host){
  if(!host||!root.portalSession?.identity||!root.SharedKy?.Session||!root.mountSharedKy)return;
  const person=root.portalSession.identity(),actor=actorId(person),date=today();
  if(active?.host===host&&active.actor===actor&&active.date===date&&host.isConnected&&host.hasChildNodes())return;
  const ticket=++generation;active={host,actor,date};
  const current=()=>ticket===generation&&host.isConnected&&actorId(root.portalSession.identity())===actor;
  const kind=person?.kind||'employee';
  if(!person?.code||kind==='worker'&&!person.worker_id){host.textContent='本人のログインを確認してください。';return}
  host.textContent='本日のKYを確認中…';
  const reload=async()=>{
   const result=await root.portalSession.call('kyInbox',{p_actor_kind:kind,p_actor_code:person.code,p_date:date});
   if(!current())return;
   if(result?.date!==date||!Array.isArray(result.rows))throw Error('本日のKYを確認できません。');
   host.replaceChildren();const allSites=document.createElement('button');allSites.type='button';allSites.className='secondary';allSites.textContent='← 現場一覧へ';allSites.onclick=()=>{const url=new URL(root.location.href);url.searchParams.delete('view');root.history.replaceState(root.history.state,'',url);if(typeof page!=='undefined')page='sites';root.render()};host.append(allSites);const heading=document.createElement('h1');heading.textContent='本日のKY';host.append(heading);
   const intro=document.createElement('p');intro.textContent='参加したKYを開き、自分の項目を一つずつ確認してください。';host.append(intro);
   if(!result.rows.length){const empty=document.createElement('p');empty.textContent='本日のKYはまだありません。現場の職長に確認してください。';host.append(empty);return}
   for(const row of result.rows){
    if(!row||typeof row.siteKey!=='string'||typeof row.recordId!=='string'||!Number.isSafeInteger(Number(row.revision))||!row.payload?.kyCanonical||row.date!==date)continue;
    const k=row.payload.kyCanonical,me=kind==='worker'?'worker:'+person.worker_id:'employee:'+person.code;
    if(!Array.isArray(k.roster)||!k.roster.includes(me))continue;
    const button=document.createElement('button');button.type='button';button.className='secondary';button.style.cssText='display:block;width:100%;text-align:left;margin:10px 0;padding:14px';
    button.innerHTML='<strong>'+escapeText(row.siteName||'現場')+'</strong><br><small>'+escapeText(row.work||'作業内容未記入')+' ／ 第'+escapeText(row.revision)+'版</small>';
    button.onclick=async()=>{
     if(!current())return;const back=document.createElement('button');back.type='button';back.className='secondary';back.textContent='← 本日のKY一覧へ';back.onclick=()=>reload().catch(showError);const panel=document.createElement('section');panel.className='panel';host.replaceChildren(back,panel);
     try{const payload=structuredClone(row.payload);payload.data??={};payload.data.daily??={};const session=new root.SharedKy.Session({records:{save:async()=>{throw Error('KY内容の保存には職長の権限が必要です')},list:async()=>{throw Error('一覧から開き直してください')}},rpc:(method,args)=>root.portalSession.call(method,args),identity:()=>root.portalSession.identity(),site:row.siteKey,record:{id:row.recordId,revision:row.revision,payload},canManage:false,canConfirmLeader:row.canConfirmLeader===true&&k.leader===me});session.inboxMode=true;await root.mountSharedKy(panel,{session,members:[],isCurrent:current})}
     catch(error){if(current())panel.textContent=error.message||'KYを確認できません。'}
    };
    host.append(button)
   }
  };
  const showError=error=>{if(current())host.textContent=error?.message||'本日のKYを確認できません。再読み込みしてください。'};
  try{await reload()}catch(error){showError(error)}
 };
 if(root.addEventListener){root.addEventListener('portal-session-ready',()=>{if(new URL(root.location.href).searchParams.get('view')==='ky'&&root.portalSession?.connected?.())root.render?.();else if(active){generation++;active=null}});root.addEventListener('DOMContentLoaded',()=>{const previous=root.render;if(typeof previous!=='function')return;root.render=function(){if(new URL(root.location.href).searchParams.get('view')==='ky'&&root.portalSession?.connected?.())return root.mountSiteKyInbox(root.document.getElementById('app'));if(active){generation++;active=null}return previous.apply(this,arguments)};if(new URL(root.location.href).searchParams.get('view')==='ky')root.render()})}
})(window);
