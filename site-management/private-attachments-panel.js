(function(root){
'use strict';
root.mountPrivateAttachments=async function(container,{client,site,section,signal}){
 container.replaceChildren();let active=true,rows=[],pending=[],busy=false;const urls=new Set();
 const valid=()=>active&&!signal?.aborted&&container.isConnected;
 const node=(tag,text)=>{const e=document.createElement(tag);if(text)e.textContent=text;return e};
 const title=node('h2',section+'・共有ファイル'),status=node('p'),list=node('div'),form=node('form');
 status.setAttribute('role','status');list.className='media-gallery';
 const input=node('input');input.type='file';input.multiple=true;input.required=true;input.disabled=true;
 input.accept=section==='写真'?'.jpg,.jpeg,.png,.webp,.gif':'.pdf,.jpg,.jpeg,.png,.webp,.gif,.xls,.xlsx,.doc,.docx';
 const categories=['施工前','施工中','施工後','足場','契約外追加足場','常用伝票','契約書','図面','その他'];
 const select=node('select');select.setAttribute('aria-label','分類');categories.forEach(c=>select.append(new Option(c,c)));select.value='その他';
 const captured=node('input');captured.type='datetime-local';captured.setAttribute('aria-label','撮影日時');
 const ordinary=node('input');ordinary.type='checkbox';ordinary.setAttribute('aria-label','通常の現場写真として縮小する');
 const label=(name,e)=>{const l=node('label',name);l.append(e);return l};
 const submit=node('button','共有する');submit.type='submit';submit.disabled=true;
 form.append(label('分類',select),label('撮影日時（分かる場合のみ・日本時間）',captured),label('ファイル（複数可・1件25MB以内）',input));
 if(section==='写真')form.append(label('通常の現場写真（容量を抑えて保存・3年保管後の削除対象）',ordinary),node('p','選択すると大きなJPEG写真だけを縮小します。縮小した場合、撮影時の原本は送信しません。図面・原本・署名・事故証拠は選択せず、原本のまま保存してください。現場完了・写真の登録・更新のうち最後の日から3年保管します。'));
 form.append(submit);
 async function preparePhoto(file){
  if(section!=='写真'||!ordinary.checked||file.type!=='image/jpeg'||file.size<=2*1024*1024)return file;
  const image=await createImageBitmap(file),long=Math.max(image.width,image.height);
  try{
   const scale=Math.min(1,2048/long),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));
   const context=canvas.getContext('2d');if(!context)throw Error('写真を縮小できません');context.drawImage(image,0,0,canvas.width,canvas.height);
   const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.82));if(!blob)throw Error('写真を縮小できません');
   return blob.size<file.size?new File([blob],file.name,{type:'image/jpeg',lastModified:file.lastModified}):file;
  }finally{image.close()}
 }
 const filters=node('div');filters.className='media-filter';const category=node('select'),date=node('input'),search=node('input');
 category.setAttribute('aria-label','分類で絞り込む');category.append(new Option('すべての分類',''));categories.forEach(c=>category.append(new Option(c,c)));
 date.type='date';date.setAttribute('aria-label','撮影日で絞り込む');search.type='search';search.placeholder='ファイル名で検索';search.setAttribute('aria-label',search.placeholder);
 const button=(label,action)=>{const b=node('button',label);b.type='button';b.onclick=async()=>{b.disabled=true;try{await action()}catch(e){if(valid())status.textContent=e.message}finally{b.disabled=false}};return b};
 filters.append(category,date,search,button('共有一覧を再読込',()=>refresh()),button('絞り込み解除',()=>{category.value=date.value=search.value='';draw()}));
 const preview=node('div');container.append(title,form,status,filters,preview,list);
 const clearPreview=()=>{preview.replaceChildren();for(const url of urls)URL.revokeObjectURL(url);urls.clear()};
 const cleanup=()=>{active=false;clearPreview();signal?.removeEventListener('abort',cleanup)};signal?.addEventListener('abort',cleanup,{once:true});if(signal?.aborted)cleanup();
 const open=async(row,download)=>{const blob=await client.download(row);if(!valid())return;clearPreview();const url=URL.createObjectURL(blob);urls.add(url);
  if(!download&&['image/jpeg','image/png','image/webp','image/gif'].includes(blob.type)){const img=node('img');img.src=url;img.alt=row.payload.name;img.style.cssText='max-width:100%;max-height:70vh;object-fit:contain';preview.append(node('h3',row.payload.name),img,button('閉じる',clearPreview));}
  else if(!download&&blob.type==='application/pdf'){const frame=node('iframe');frame.src=url;frame.title=row.payload.name;frame.style.cssText='width:100%;height:70vh;border:1px solid #ccd6e0';preview.append(node('h3',row.payload.name),frame,button('閉じる',clearPreview));}
  else{const a=node('a');a.href=url;a.download=row.payload.name;a.click();}
 };
 function draw(){if(!valid())return;list.replaceChildren();const ordered=rows.slice().sort((a,b)=>String(b.created_at||b.payload.date||'').localeCompare(String(a.created_at||a.payload.date||'')));
  const visible=ordered.filter(r=>(!category.value||(r.payload.category||'その他')===category.value)&&(!date.value||(r.payload.capturedAt||'').slice(0,10)===date.value)&&(!search.value||r.payload.name.includes(search.value)));
  for(const row of visible){const p=row.payload,line=node('article');line.className='media-card';line.style.cssText='padding:16px;overflow-wrap:anywhere';line.append(node('h3',p.name),node('p',(p.category||'その他')+' ／ '+(p.state==='ready'?'共有済み':p.state==='retired'?'保管期限により削除済み':'送信待ち')));
   line.append(node('p','撮影日時：'+(p.capturedAt?.replace('T',' ')||'不明')),node('p','登録日時：'+(row.created_at||p.date?new Date(row.created_at||p.date).toLocaleString('ja-JP'):'不明')),node('p','登録者：'+(row.created_by||'記録を確認中')));
   if(section==='工程表')line.append(node('p','第'+(ordered.length-ordered.indexOf(row))+'版'));
   if(p.state==='ready')line.append(button('プレビュー',()=>open(row,false)),button(p.photoRetention==='ordinary'?'共有ファイルを保存':'原本を保存',()=>open(row,true)));list.append(line);
  }
  for(const op of pending.filter(x=>x.site===site&&x.section===section)){const line=node('p',op.file.name+'：送信未完了 ');line.append(button('再送する',async()=>{await client.retry(op.id);await refresh()}));list.append(line)}
  if(!visible.length)list.prepend(node('p','該当する共有ファイルはありません。'));
 }
 const refresh=async()=>{const result=await client.list(site,section),queue=await client.pending();if(!valid())return;rows=result;pending=queue;const allowed=!!client.records.access(site,section)?.manage;form.hidden=!allowed;input.disabled=submit.disabled=!allowed||busy;draw()};
 category.onchange=date.onchange=search.oninput=draw;
 form.onsubmit=async e=>{e.preventDefault();if(busy||!form.reportValidity())return;const files=[...input.files],metadata={category:select.value,capturedAt:captured.value,photoRetention:section==='写真'&&ordinary.checked?'ordinary':'original'};busy=true;input.disabled=submit.disabled=select.disabled=captured.disabled=ordinary.disabled=true;const failed=[],retained=[];status.textContent='共有しています…';try{for(const file of files){if(!valid())return;try{const upload=await preparePhoto(file);if(!valid())return;await client.add(site,section,upload,metadata)}catch(e){failed.push(file.name+'：'+e.message);if(!e.uploadId)retained.push(file)}}if(valid())status.textContent=failed.length?failed.join(' ／ ')+'。送信待ちがある場合は再送してください。':'共有しました';}finally{busy=false;if(valid()){const transfer=new DataTransfer();retained.forEach(file=>transfer.items.add(file));input.files=transfer.files;select.disabled=captured.disabled=ordinary.disabled=false;await refresh().catch(e=>status.textContent=e.message)}}};
 await refresh().catch(e=>{if(valid())status.textContent=e.message});return cleanup;
};
})(window);
