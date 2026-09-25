(function(){
'use strict';
const n=v=>Number(v).toLocaleString('ja-JP');
window.stockOverview=function(q='',sq=''){
 const rows=inventorySummary().filter(i=>i.name.toLowerCase().includes(q.toLowerCase())),sites=state.sites.filter(s=>s.name.includes(sq));
 return `<div class="stock-tools"><input aria-label="部材を検索" placeholder="部材名・規格を検索" value="${esc(q)}" oninput="stockSearch(this.value)"><input aria-label="現場を検索" placeholder="現場名で列を絞る" value="${esc(sq)}" oninput="stockSiteSearch(this.value)"><span class="meta">${rows.length}品目 ／ ${sites.length}現場</span></div><p class="hint">総保有数 ＝ 倉庫残数 ＋ 全現場の持出数。現場を絞っても、左側の合計は全現場分です。数量は各部材の単位で表示します。</p><div class="stock-scroll stock-overview"><table class="stock-sheet"><colgroup><col style="width:170px"><col span="4" style="width:66px">${sites.map(()=>'<col style="width:88px">').join('')}</colgroup><thead><tr><th>部材名・規格</th><th>単位</th><th>総保有数</th><th>倉庫残数</th><th>全現場</th>${sites.map(s=>`<th title="${esc(s.name)}"><button onclick="goTab(${s.id},'資材台帳')">${esc(s.name)}</button></th>`).join('')}</tr></thead><tbody>${rows.map(i=>`<tr><td>${esc(i.name)}</td><td>${esc(i.unit)}</td><td>${n(i.warehouse+i.held)}</td><td class="warehouse">${n(i.warehouse)}</td><td>${n(i.held)}</td>${sites.map(s=>{let v=i.sites[String(s.id)]||0;return `<td class="${v?'value':'stock-zero'}">${n(v)}</td>`}).join('')}</tr>`).join('')||`<tr><td colspan="${5+sites.length}">部材がありません。「検証用の部材を追加」からサンプルを読み込めます。</td></tr>`}</tbody></table></div>`;
};
window.stockSampleForm=function(){
 const exists=inventorySnapshot().items.some(i=>i.id==='sample-stock-0');
 show(`<h2>検証用の足場部材</h2><p>手すり・アンチ・支柱など30品目と、現在の先頭３現場への出荷例を追加します。数量はすべて架空です。既存の在庫は上書きしません。</p><p>このブラウザに保存され、同じURLを開き直しても残ります。</p><p id="sampleError" role="alert"></p><div class="modalfoot"><button class="secondary" onclick="closeModal()">閉じる</button><button id="sampleAdd" class="primary" ${exists?'disabled':''}>${exists?'検証用部材は追加済みです':'架空の部材・出荷例を追加'}</button></div>`);
 $('sampleAdd').onclick=async()=>{const btn=$('sampleAdd');btn.disabled=true;try{
 const names=['手すり 1800','手すり 1200','手すり 900','手すり 600','アンチ 1800×500','アンチ 1800×250','アンチ 1200×500','アンチ 900×500','支柱 3600','支柱 2700','支柱 1800','支柱 900','支柱 600','筋交 1800','筋交 1200','筋交 900','ジャッキベース','自在ジャッキ','階段','階段手すり','ブラケット 600','ブラケット 400','踏板 600','踏板 900','単管 4000','単管 2000','直交クランプ','自在クランプ','壁つなぎ','養生メッシュ'];
 const ops=[],date=new Date(Date.now()+9*3600000).toISOString().slice(0,10),sites=state.sites.slice(0,3);
 names.forEach((name,i)=>{const id='sample-stock-'+i;ops.push({kind:'item',id,name:'【検証用】'+name,unit:'個',initial:200+i*10});sites.forEach((s,j)=>ops.push({kind:'dispatch',id:`sample-move-${i}-${j}`,batchId:'sample-slip-'+j,item:id,site:String(s.id),qty:10+(i+j)%6*5,actor:'検証用サンプル',date,note:'架空の数量・実在庫ではありません'}))});
 await inventoryCommitBatch(ops,inventorySnapshot().revision);closeModal();stockMode('overview');notify('検証用30品目と出荷例を保存しました');
 }catch(e){$('sampleError').textContent=e.message;btn.disabled=false}};
};
})();
