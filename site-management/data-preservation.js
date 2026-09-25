(function(){
'use strict';
const included=k=>k.startsWith('jinshou-')&&!/auth|token|session|binding|password|credential/i.test(k);
window.siteDataBackup=async()=>{
 const status=document.getElementById('backupStatus');
 try{
  status.textContent='記録と添付ファイルをまとめています…';
  const zip=new JSZip(),records={};
  for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(included(k))records[k]=localStorage.getItem(k)}
  zip.file('records.json',JSON.stringify(records,null,2));
  const database=await db();
  const files=await new Promise((resolve,reject)=>{const tx=database.transaction('files'),store=tx.objectStore('files'),keys=store.getAllKeys(),values=store.getAll();tx.oncomplete=()=>resolve(keys.result.map((key,i)=>({key,value:values.result[i]})));tx.onerror=()=>reject(tx.error)});
  const manifest=[];
  for(let i=0;i<files.length;i++){const {key,value}=files[i];if(!(value instanceof Blob))throw Error('添付ファイルの形式を確認できません。保存を中止しました。');const path='files/'+i;zip.file(path,await value.arrayBuffer());manifest.push({key,path,name:value.name||'',type:value.type,size:value.size,lastModified:value.lastModified||null})}
  zip.file('manifest.json',JSON.stringify({format:'jinshou-local-backup',version:1,createdAt:new Date().toISOString(),records:Object.keys(records).length,files:manifest},null,2));
  const blob=await zip.generateAsync({type:'blob',compression:'STORE'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='現場管理_端末内データ_'+new Date().toLocaleDateString('sv-SE')+'.zip';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
  status.textContent=`控えを作成しました。記録 ${Object.keys(records).length} 種類・添付 ${files.length} 件。ダウンロード先で保存を確認してください。`;
 }catch(e){status.textContent='控えを作成できませんでした。元の記録は変更していません。 '+e.message}
};
function open(){show('<h2>この端末のデータ保全</h2><p>現場・見積・資材・写真・KY・事故報告など、このブラウザーに保存した記録と添付ファイルの控えをまとめて保存します。</p><p>ポータル側の受講記録は含みません。ログイン情報は含めません。</p><p>これは移行・復旧作業用の控えです。この画面からの自動復元はまだありません。保存後も元のデータは残ります。</p><button class="primary" id="downloadLocalBackup">記録と添付ファイルの控えを保存</button><p id="backupStatus" role="status"></p><button class="secondary" onclick="closeModal()">閉じる</button>');document.getElementById('downloadLocalBackup').onclick=siteDataBackup}
window.addEventListener('DOMContentLoaded',()=>{const b=document.createElement('button');b.className='secondary';b.textContent='データ保全';b.onclick=open;document.querySelector('main .top').append(b);if(mainStorageError){const notice=document.createElement('div');notice.className='notice';notice.setAttribute('role','alert');notice.textContent=mainStorageError;document.querySelector('main .top').after(notice)}});
})();
