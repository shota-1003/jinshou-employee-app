(function(root){
'use strict';
function stable(value){if(Array.isArray(value))return '['+value.map(stable).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';return JSON.stringify(value)}
class SharedRecords {
 constructor({rpc,identity,queue,uuid=()=>crypto.randomUUID()}){this.rpc=rpc;this.identity=identity;this.queue=queue;this.uuid=uuid;this.revisions=new Map();this.busy=new Map();this.saving=new Map();this.generation=0;this.listeners=new Set();this.owner=null;this.resolving=new Set();this.accesses=new Map()}
 key(site,section,id){return JSON.stringify([site,section,id])}
 subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn)}
 emit(event){for(const fn of this.listeners)fn(event)}
 clear(){this.generation++;this.revisions.clear();this.accesses.clear();this.emit({type:'cleared'})}
 actor(){const a=this.identity(),owner=a?.kind&&a?.code?stable([a.kind,a.code]):null;if(this.owner!==owner){this.owner=owner;this.clear()}if(!owner)throw Error('ログインを確認してください');return {p_actor_kind:a.kind,p_actor_code:a.code}}
 assertActor(actor,generation){if(stable(actor)!==stable(this.actor())||generation!==this.generation)throw Error('ログインが変わりました。再ログイン後に送信結果を確認してください')}
 access(site,section){this.actor();return this.accesses.get(JSON.stringify([site,section]))||null}
 async list(site,section){const actor=this.actor(),generation=this.generation,items=[],versions=new Map();let cursor='';
  for(let page=0;page<100;page++){
   const result=await this.rpc('site_records_list',{...actor,p_site_key:site,p_section:section,p_after_id:cursor,p_limit:100});this.assertActor(actor,generation);
   const rows=Array.isArray(result)?result:result.rows;if(!Array.isArray(rows))throw Error('共有記録の形式を確認できません');
   for(const r of rows){if(!r.id||!Number.isSafeInteger(Number(r.revision))||Number(r.revision)<1)throw Error('共有記録の版を確認できません');versions.set(this.key(site,section,r.id),Number(r.revision));if(!r.deleted)items.push(r)}
   if(rows.length<100){this.accesses.set(JSON.stringify([site,section]),result.access?{...result.access,actor:result.actor||null}:null);for(const [key,value]of versions)this.revisions.set(key,value);return items}const next=rows.at(-1).id;if(next<=cursor)throw Error('共有記録の読込位置が不正です');cursor=next;
  }throw Error('記録が多いため、表示範囲を絞ってください');
 }
 save(site,section,id,payload,options={}){const expectedActor=this.actor();if(this.resolving.has(stable([expectedActor,this.key(site,section,id)])))return Promise.reject(Error('未送信記録を整理中です'));const generation=this.generation,key=stable([expectedActor,generation,this.key(site,section,id)]),snapshot=structuredClone(payload),settings=structuredClone(options),fingerprint=stable([snapshot,settings]),current=this.saving.get(key);if(current){if(current.fingerprint!==fingerprint)return Promise.reject(Error('この記録を保存中です'));return current.job}const job=Promise.resolve().then(()=>{this.assertActor(expectedActor,generation);return this.prepare(site,section,id,snapshot,settings)}).finally(()=>this.saving.delete(key));this.saving.set(key,{fingerprint,job});return job}
 async prepare(site,section,id,payload,{revision,deleted=false}={}){
  const actor=this.actor(),generation=this.generation,key=this.key(site,section,id);
  const value={...actor,p_site_key:site,p_section:section,p_id:String(id),p_payload:payload,p_expected_revision:revision??this.revisions.get(key)??0,p_deleted:deleted};
  if(!this.queue.putIfAbsent||!this.queue.removeIfRequest)throw Error('未送信記録を安全に保存できません。アプリを更新してください');
  const op=await this.queue.putIfAbsent(actor,key,{key,value,requestId:this.uuid(),createdAt:new Date().toISOString()});this.assertActor(actor,generation);
  if(stable(op.value)!==stable(value))throw Error('この記録の送信が未完了です。先に再送または内容を確認してください');
  this.emit({type:'pending',key});return this.send(op);
 }
 async send(op){
  const actor=this.actor();if(this.resolving.has(stable([actor,op.key])))throw Error('未送信記録を整理中です');if(stable(actor)!==stable({p_actor_kind:op.value.p_actor_kind,p_actor_code:op.value.p_actor_code}))throw Error('別の人の未送信記録は送れません');
  const generation=this.generation,busyKey=stable([actor,generation,op.key,op.requestId]);if(this.busy.has(busyKey))return this.busy.get(busyKey);
  const job=Promise.resolve().then(async()=>{try{
   this.assertActor(actor,generation);const result=await this.rpc('site_record_save',{...op.value,p_request_id:op.requestId});this.assertActor(actor,generation);
   if(!result||String(result.id)!==op.value.p_id||!Number.isSafeInteger(Number(result.revision))||Number(result.revision)<1)throw Error('保存結果を確認できません');
   await this.queue.removeIfRequest(actor,op.key,op.requestId);this.assertActor(actor,generation);this.revisions.set(op.key,Number(result.revision));this.emit({type:'saved',key:op.key,result});return result;
  }catch(error){if(generation===this.generation&&stable(actor)===stable(this.actor()))this.emit({type:'failed',key:op.key,error});throw error}finally{this.busy.delete(busyKey)}});this.busy.set(busyKey,job);return job;
 }
 async resolvePending(key,requestId){
  const actor=this.actor(),generation=this.generation,guard=stable([actor,key]);
  if(typeof key!=='string'||typeof requestId!=='string'||!requestId)throw Error('未送信記録を確認してください');
  if(this.resolving.has(guard)||[...this.saving.keys()].some(k=>{const x=JSON.parse(k);return stable(x[0])===stable(actor)&&x[2]===key})||[...this.busy.keys()].some(k=>{const x=JSON.parse(k);return stable(x[0])===stable(actor)&&x[2]===key}))throw Error('保存中の記録は整理できません');
  this.resolving.add(guard);
  try{const op=await this.queue.get(actor,key);this.assertActor(actor,generation);if(!op||op.requestId!==requestId)throw Error('未送信記録が変わりました。もう一度比較してください');
   const removed=await this.queue.removeIfRequest(actor,key,requestId);this.assertActor(actor,generation);if(!removed)throw Error('未送信記録が変わりました。もう一度比較してください');this.emit({type:'resolved',key});return true;
  }finally{this.resolving.delete(guard)}
 }
 async pending(){const actor=this.actor(),generation=this.generation,rows=await this.queue.list(actor);this.assertActor(actor,generation);return rows}
 async retry(key){const actor=this.actor(),generation=this.generation,op=await this.queue.get(actor,key);this.assertActor(actor,generation);if(!op)throw Error('未送信の記録が見つかりません');return this.send(op)}
}
function indexedQueue(){let connection;const owner=a=>JSON.stringify([a.p_actor_kind,a.p_actor_code]);async function db(){if(!connection)connection=new Promise((resolve,reject)=>{const req=indexedDB.open('jinshou-shared-outbox',1);req.onupgradeneeded=()=>req.result.createObjectStore('pending',{keyPath:'id'});req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});return connection}
 async function request(mode,fn){const database=await db();return new Promise((resolve,reject)=>{const tx=database.transaction('pending',mode),req=fn(tx.objectStore('pending'));tx.oncomplete=()=>resolve(req?.result);tx.onabort=()=>reject(tx.error||Error('控えを保存できません'));tx.onerror=()=>reject(tx.error)})}
 async function compare(a,k,op,requestId){const database=await db();return new Promise((resolve,reject)=>{const tx=database.transaction('pending','readwrite'),store=tx.objectStore('pending'),id=owner(a)+k,read=store.get(id);let result;read.onsuccess=()=>{const existing=read.result;if(op){result=existing?.op||op;if(!existing)store.put({id,owner:owner(a),op})}else{result=existing?.op?.requestId===requestId;if(result)store.delete(id)}};tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error||Error('控えを保存できません'));tx.onerror=()=>reject(tx.error)})}
 return {get:async(a,k)=>(await request('readonly',s=>s.get(owner(a)+k)))?.op,putIfAbsent:(a,k,op)=>compare(a,k,op),removeIfRequest:(a,k,id)=>compare(a,k,null,id),list:async a=>(await request('readonly',s=>s.getAll())).filter(r=>r.owner===owner(a)).map(r=>r.op)};
}
root.SiteSharedRecords={SharedRecords,indexedQueue};if(typeof module!=='undefined')module.exports=root.SiteSharedRecords;
})(typeof window==='undefined'?globalThis:window);

