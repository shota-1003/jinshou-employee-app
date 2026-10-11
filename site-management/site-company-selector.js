(function(){'use strict';
window.addEventListener('DOMContentLoaded',()=>{
 const original=siteForm;
 siteForm=function(id){
  original(id);
  const f=$('sharedProfileForm')||$('siteForm');
  if(!f||f.id==='sharedProfileForm')return; // Shared profile owns its picker.
  const actor=JSON.stringify(portalSession.identity()),prior=state.sites.find(s=>String(s.id)===String(id))||null;
  const pickers={},choices={prime:null,client:null},touched={prime:false,client:false},peopleTouched={prime:false,client:false};
  const notice=document.createElement('p');notice.setAttribute('role','status');f.prepend(notice);
  const retry=document.createElement('button');retry.type='button';retry.className='secondary';retry.textContent='顧客候補を再読込';retry.hidden=true;notice.after(retry);
  const matches=()=>f.isConnected&&actor===JSON.stringify(portalSession.identity());
  const sharedPeople=(key,company)=>{
   const box=$(key+'Contacts');if(!box)return;
   const selected=new Set(company?.id===prior?.[key+'CompanyId']?(prior?.[key+'People']||[]).map(String):[]);box.replaceChildren();
   for(const person of company?.people||[]){const label=document.createElement('label'),input=document.createElement('input');
    input.type='checkbox';input.name=key+'People';input.value=person.name;input.checked=selected.has(person.name);input.onchange=()=>{peopleTouched[key]=true};
    label.append(input,document.createTextNode(person.name+(person.dept?' ／ '+person.dept:'')));box.append(label)}
  };
  for(const key of ['prime','client']){
   const anchor=f.elements[key],picker=document.createElement('select');picker.name=key+'SharedChoice';pickers[key]=picker;
   picker.innerHTML='<option value="">共有顧客から選ぶ（未選択なら現在の入力を維持）</option>';anchor.before(picker);
   anchor.addEventListener('change',()=>{if(!matches())return;choices[key]=null;touched[key]=true;picker.value=''});
   picker.addEventListener('change',()=>{if(!matches())return;touched[key]=true;peopleTouched[key]=true;const c=window.siteSharedCompanies?.().find(x=>x.id===picker.value);choices[key]=c||null;
    if(c){anchor.value='';sharedPeople(key,c)}else if(prior?.[key+'CompanyId'])sharedPeople(key,null)});
  }
  const loadChoices=async()=>{retry.disabled=true;notice.textContent='顧客候補を確認中…';try{
   const options=await siteSharedCustomerChoicesLoad();if(!matches())return;
   for(const key of ['prime','client']){const picker=pickers[key],current=picker.value||(!touched[key]?prior?.[key+'CompanyId']||'':'');
    picker.replaceChildren(new Option('共有顧客から選ぶ（未選択なら現在の入力を維持）',''));
    for(const c of options){const duplicate=options.filter(x=>x.name===c.name).length>1;picker.add(new Option(c.name+(duplicate?' ／ ID '+c.id.slice(0,8):''),c.id))}
    if(options.some(c=>c.id===current)){picker.value=current;choices[key]=options.find(c=>c.id===current);if(!touched[key])sharedPeople(key,choices[key])}
   }
   notice.textContent='';retry.hidden=true;
  }catch(e){if(matches()){notice.textContent='顧客候補を取得できません。既存の現場情報は保持されます: '+e.message;retry.hidden=false}}
  finally{retry.disabled=false}};
  retry.onclick=loadChoices;loadChoices();
  f.onsubmit=async event=>{event.preventDefault();if(!f.reportValidity()||!matches())return;
   const map=f.elements.mapLink?.value.trim();if(map&&!safePlaceUrl(map)){notify('現場の地図URLは Google / Apple マップのHTTPS共有URLを指定してください');return}
   if(f.elements.mapLink)f.elements.mapLink.value=map||'';
   const data=new FormData(f),value=Object.fromEntries(data);value.id=id||Date.now();
   if(!id){if(!String(value.createdBy||'').trim()){notify('案件作成者を入力してください');return}value.createdAt=new Date().toLocaleDateString('sv-SE')}
   for(const key of ['prime','client']){const selected=choices[key],oldId=prior?.[key+'CompanyId']||'',oldLocal=prior?.[key];
    delete value[key+'SharedChoice'];const localValue=Number(value[key]);const unchanged=!touched[key];
    value[key]=selected?.id||(unchanged&&oldId?oldLocal:localValue);
    value[key+'CompanyId']=selected?.id||(unchanged?oldId:'');
    value[key+'Name']=selected?.name||(unchanged?prior?.[key+'Name']||'':company(value[key])?.name||'');
    const pickedPeople=data.getAll(key+'People');value[key+'People']=unchanged&&!peopleTouched[key]&&oldId?[...(prior?.[key+'People']||[])]:pickedPeople;
   }
   if(value.start&&value.end&&value.end<value.start){notify('完了予定日は着工日以降にしてください');return}
   try{if(prior)Object.assign(prior,value);else state.sites.push(value);save();closeModal();render();
    if(!id&&window.siteSyncNow){const epoch=window.siteSyncSessionEpoch?.();await siteSyncNow(value.id);
     if(portalSession.connected()&&actor===JSON.stringify(portalSession.identity())&&epoch===window.siteSyncSessionEpoch?.())goTab(value.id,'メンバー')}
   }catch(error){if(f.isConnected){let box=f.querySelector('[data-company-error]');if(!box){box=document.createElement('p');box.dataset.companyError='';box.setAttribute('role','alert');f.append(box)}box.textContent=error.message}}
  };
 };
});
})();
