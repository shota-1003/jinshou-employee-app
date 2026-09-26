(function(root){
'use strict';
const labels={dispatch:'持出',return:'返却',purchase:'購入',reverse:'取消・訂正',loss:'紛失',damage:'破損'};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function model(view){
 const holdings=new Map(),batches=new Map();
 for(const m of view.moves||[]){
  if(m.site&&m.site!=='warehouse'){
   const key=String(m.site);if(!holdings.has(key))holdings.set(key,new Map());
   const byItem=holdings.get(key),delta=m.type==='dispatch'?Number(m.qty):['return','loss','damage'].includes(m.type)?-Number(m.qty):m.type==='reverse'?-Number(m.delta):0;
   byItem.set(m.item,(byItem.get(m.item)||0)+delta);
  }
  const key=m.batchId||m.id;if(!batches.has(key))batches.set(key,[]);batches.get(key).push(m);
 }
 return{holdings,batches};
}
function mount(container,{view,site,siteName='現場',print}){
 if(!container)return;
 const data=model(view),items=view.items||[],itemMap=new Map(items.map(i=>[i.id,i]));
 const profiles=root.siteSharedProfilesSnapshot?.();
 const names=new Map((profiles?.ready?profiles.rows:[]).filter(r=>r.portal_site_id!=null).map(r=>[String(r.portal_site_id),r.name||r.profile?.name]));
 if(site)names.set(String(site),siteName);
 const name=id=>id==='warehouse'?'倉庫':names.get(String(id))||'名称未登録の現場（'+String(id)+'）';
 let mode='overview',query='',siteQuery='';
 container.innerHTML='<h3>資材を探す</h3><div data-stock-tabs></div><div class="stock-tools"><label>部材を検索<input data-item-search placeholder="部材名・規格"></label><label>現場を検索<input data-site-search placeholder="現場名"></label></div><div data-stock-view></div>';
 const tabs=container.querySelector('[data-stock-tabs]'),body=container.querySelector('[data-stock-view]');
 function button(text,fn){const b=document.createElement('button');b.type='button';b.className='secondary';b.textContent=text;b.onclick=fn;return b;}
 for(const [key,title] of [['overview','総合在庫表'],['items','部材別の在庫'],['sites','現場から探す'],['history','伝票履歴']]){const b=button(title,()=>{mode=key;draw()});b.dataset.stockMode=key;tabs.append(b)}
 function table(columns,rows){return '<div style="overflow-x:auto"><table class="stock-sheet"><thead><tr>'+columns.map(c=>'<th>'+esc(c)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map(v=>'<td>'+esc(v)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>'}
 function matches(i){return String(i?.name||'').toLocaleLowerCase().includes(query.toLocaleLowerCase())}
 function printRows(title,columns,rows){if(!rows.length||!print)return;body.append(button(title+'を印刷',()=>print(title,rows.map(row=>Object.fromEntries(columns.map((c,i)=>[c,row[i]]))))))}
 function draw(){
  tabs.querySelectorAll('button').forEach(b=>{b.classList.toggle('active',b.dataset.stockMode===mode);b.setAttribute('aria-pressed',String(b.dataset.stockMode===mode))});
  body.replaceChildren();const selected=items.filter(matches);
  const sites=[...data.holdings.keys()].filter(id=>(!site||id===String(site))&&name(id).includes(siteQuery)).sort((a,b)=>name(a).localeCompare(name(b),'ja'));
  if(mode==='overview'||mode==='items'){
   const siteColumns=sites.map(id=>sites.some(other=>other!==id&&name(other)===name(id))?name(id)+'（'+id+'）':name(id));
   const manager=!!view.capabilities?.manager,columns=['部材名・規格','単位',...(manager?['総保有数','倉庫残数']:[]),site?'この現場の保有数':'全現場の保有数',...(mode==='overview'?siteColumns:[])];
   const rows=selected.map(i=>[i.name,i.unit,...(manager?[Number(i.warehouse||0)+Number(i.held||0),Number(i.warehouse||0)]:[]),Number(i.held||0),...(mode==='overview'?sites.map(s=>data.holdings.get(s).get(i.id)||0):[])]);
   const p=document.createElement('p');p.textContent=manager?(site?'総保有数は倉庫とこの現場の合計です。全社合計は資材センターで確認できます。':'総保有数は倉庫と全現場の合計です。現場を検索しても左側の合計は変わりません。'):'閲覧できる範囲の現場保有数を表示しています。';body.append(p);
   const div=document.createElement('div');div.innerHTML=table(columns,rows);body.append(div);printRows(mode==='overview'?'総合在庫表':'部材別の在庫',columns,rows);
   if(!rows.length){const p=document.createElement('p');p.textContent='該当する部材はありません。';body.append(p)}
  }else if(mode==='sites'){
   let count=0;for(const id of sites){const rows=selected.filter(i=>(data.holdings.get(id).get(i.id)||0)>0).map(i=>[i.name,i.unit,data.holdings.get(id).get(i.id)]);if(!rows.length)continue;count++;const h=document.createElement('h4');h.textContent=name(id);body.append(h);const div=document.createElement('div');div.innerHTML=table(['部材','単位','現在の保有数'],rows);body.append(div);printRows(name(id)+'の保有部材',['部材','単位','現在の保有数'],rows)}
   if(!count)body.textContent='該当する現場に未返却の部材はありません。';
  }else{
   let count=0;for(const [id,moves] of [...data.batches].reverse()){
    const rows=moves.filter(m=>(!site||String(m.site)===String(site))&&name(m.site).includes(siteQuery)&&matches(itemMap.get(m.item))).map(m=>[m.date,name(m.site),labels[m.type]||m.type,itemMap.get(m.item)?.name||m.item,m.qty,itemMap.get(m.item)?.unit||'',m.actor,m.note||'']);
    if(!rows.length)continue;count++;const detail=document.createElement('details'),summary=document.createElement('summary');summary.textContent=rows[0][0]+' ／ '+rows[0][1]+' ／ '+rows[0][2]+' ／ '+rows[0][6]+' ／ '+rows.length+'明細';detail.append(summary);const div=document.createElement('div');div.innerHTML=table(['日付','現場','区分','部材','数量','単位','記録者','備考'],rows);detail.append(div);if(print)detail.append(button('この伝票を印刷',()=>print('資材伝票 '+id,rows.map(r=>Object.fromEntries(['日付','現場','区分','部材','数量','単位','記録者','備考'].map((c,i)=>[c,r[i]]))))));body.append(detail)
   }
   if(!count)body.textContent='該当する伝票はありません。';
  }
 }
 container.querySelector('[data-item-search]').oninput=e=>{query=e.target.value;draw()};container.querySelector('[data-site-search]').oninput=e=>{siteQuery=e.target.value;draw()};draw();
}
root.SharedInventoryBrowser={mount,model};if(typeof module!=='undefined')module.exports=root.SharedInventoryBrowser;
})(typeof window==='undefined'?globalThis:window);
