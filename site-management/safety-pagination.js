(function(){
'use strict';
window.paginateSafetyDocument=()=>{
 const stack=document.querySelector('.submission-pages');if(!stack||stack.dataset.paginated)return;stack.dataset.paginated='1';
 const originals=[...stack.children];
 for(const source of originals){
  const header=source.querySelector('header'),title=source.querySelector('h1'),meta=source.querySelector('.submission-meta'),footer=source.querySelector('footer');
  const nodes=[...source.children].filter(n=>![header,title,meta,footer].includes(n));let body,sheet,part=0;
  function fresh(){sheet=document.createElement('article');sheet.className='submission-page paginated-safety';source.before(sheet);for(const n of [header,title,meta])if(n){const clone=n.cloneNode(true);if(clone.tagName==='H1'&&part)clone.append('（続き）');sheet.append(clone)}body=document.createElement('div');body.className='safety-page-body';sheet.append(body);if(footer)sheet.append(footer.cloneNode(true));part++}
  const fits=()=>body.scrollHeight<=body.clientHeight+1;
  function append(node){body.append(node);if(!fits()&&body.children.length>1){node.remove();fresh();body.append(node)}if(!fits()&&node.textContent){splitText(node)}}
  function splitText(node){const text=node.textContent;node.textContent='';let rest=text;while(rest){let lo=1,hi=rest.length,best=0;while(lo<=hi){const mid=(lo+hi)>>1;node.textContent=rest.slice(0,mid);if(fits()){best=mid;lo=mid+1}else hi=mid-1}if(!best)throw Error('印刷内容を用紙に配置できません。記入内容を確認してください。');node.textContent=rest.slice(0,best);rest=rest.slice(best);if(rest){fresh();node=node.cloneNode(false);body.append(node)}}}
  function tableRows(sourceTable){let table,tbody;function start(){table=sourceTable.cloneNode(false);for(const child of sourceTable.children)if(['COLGROUP','THEAD'].includes(child.tagName))table.append(child.cloneNode(true));tbody=document.createElement("tbody");table.append(tbody);body.append(table)}start();
   for(const row of [...sourceTable.rows].filter(r=>r.parentElement.tagName!=='THEAD')){let clone=row.cloneNode(true);tbody.append(clone);if(fits())continue;clone.remove();if(!table.querySelector('td'))table.remove();fresh();start();tbody.append(clone);if(fits())continue;
    const texts=[...clone.cells].map(c=>c.textContent);let offsets=texts.map(()=>0);
    while(offsets.some((o,i)=>o<texts[i].length)){let lo=1,hi=Math.max(...texts.map((t,i)=>t.length-offsets[i])),best=0;while(lo<=hi){const mid=(lo+hi)>>1;[...clone.cells].forEach((c,i)=>c.textContent=texts[i].slice(offsets[i],offsets[i]+mid));if(fits()){best=mid;lo=mid+1}else hi=mid-1}if(!best)throw Error('印刷行を用紙に配置できません。');[...clone.cells].forEach((c,i)=>{c.textContent=texts[i].slice(offsets[i],offsets[i]+best);offsets[i]=Math.min(texts[i].length,offsets[i]+best)});if(offsets.some((o,i)=>o<texts[i].length)){fresh();start();clone=row.cloneNode(true);tbody.append(clone)}}
   }
  }
  fresh();for(const node of nodes){if(node.tagName==='TABLE'){const copy=node.cloneNode(true);body.append(copy);if(!fits()){copy.remove();tableRows(node)}}else append(node.cloneNode(true))}source.remove();
 }
 const pages=[...stack.children];pages.forEach((p,i)=>{const span=p.querySelector('footer span');if(span)span.textContent=(i+1)+' / '+pages.length});const heading=document.querySelector('.paper-preview-actions h2');if(heading)heading.textContent='印刷プレビュー ／ A4横・'+pages.length+'枚';
};
})();
