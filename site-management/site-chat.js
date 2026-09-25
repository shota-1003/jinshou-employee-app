(function (root) {
  'use strict';
  const KEY = 'jinshou-site-chat-v1';
  const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function read(storage) {
    const raw = storage.getItem(KEY);
    if (!raw) return [];
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.some(x => !x || typeof x.id !== 'string' || typeof x.site !== 'string' || typeof x.author !== 'string' || typeof x.message !== 'string' || typeof x.date !== 'string')) throw new Error('保存済みの連絡を読み込めません。上書きを防ぐため、登録を停止しました。');
    if(new Set(rows.map(x=>x.id)).size!==rows.length || rows.some(x=>!x.id.trim())) throw new Error('連絡履歴の識別番号が不正です。上書きせず停止しました。');
    rows.forEach(validate);
    return rows;
  }
  function validate(input) {
    const value = {site:String(input.site ?? '').trim(), author:String(input.author ?? '').trim(), message:String(input.message ?? '').trim(), date:String(input.date ?? '').trim()};
    if (!value.site || !value.author || !value.message || !value.date) throw new Error('氏名・日付・連絡内容を入力してください。');
    if(value.author.length > 80 || value.message.length > 2000) throw new Error('氏名は80文字、連絡内容は2000文字以内で入力してください。');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(value.date) || Number.isNaN(Date.parse(value.date)) || new Date(value.date).toISOString().slice(0,10)!==value.date) throw new Error('有効な日付を入力してください。');
    return value;
  }
  function append(storage, input, id) {
    const value=validate(input), rows=read(storage);
    if(typeof id!=='string'||!id.trim())throw new Error('記録の識別番号がありません。');
    const existing=rows.find(x => x.id===id);
    if(existing){
      if(['site','author','message','date'].some(k=>existing[k]!==value[k]))throw new Error('同じ記録番号の内容が異なります。画面を開き直して確認してください。');
      return false;
    }
    const record={...value,id,recordedAt:new Date().toISOString()};
    storage.setItem(KEY,JSON.stringify([...rows,record]));
    return true;
  }
  const todayJST=(now=new Date())=>new Date(now.getTime()+9*60*60*1000).toISOString().slice(0,10);
  async function appendExclusive(storage,input,id){
    if(!root.navigator?.locks?.request)throw new Error('このブラウザでは安全に同時保存できません。最新版のブラウザで開いてください。');
    return root.navigator.locks.request(KEY,()=>append(storage,input,id));
  }
  function renderSiteChat(siteId) {
    let rows=[], error='';
    try {rows=read(root.localStorage).filter(x=>x.site===String(siteId)).sort((a,b)=>b.date.localeCompare(a.date)||String(b.recordedAt).localeCompare(String(a.recordedAt)));} catch(e){error='連絡を読み込めません。保存領域の状態を確認してください。既存のデータは変更していません。';}
    const date=todayJST();
    return `<section class="site-chat"><div class="chat-heading"><div><span class="chat-eyebrow">SITE COMMUNICATION</span><h2>現場の連絡</h2><p>明日の段取りや現場の気づきを、ひとつに。</p></div><span class="chat-count">${rows.length} 件</span></div><div class="chat-local-note">この端末内だけの試作です。ほかの社員への送信・共有はされません。資材の出荷・返却は「資材台帳」で記録してください。</div>${error?`<p role="alert" class="chat-error">${error}</p>`:''}<form class="site-chat-form" data-site="${escape(siteId)}"><div class="chat-fields"><label>記入者 <span>必須・試作用</span><input name="author" required maxlength="80" placeholder="氏名を入力" autocomplete="name"></label><label>連絡日 <span>必須</span><input type="date" name="date" required value="${date}"></label></div><label>連絡内容 <span>必須</span><textarea name="message" required maxlength="2000" rows="3" placeholder="例：明日は北側入口から搬入します。8時に集合してください。"></textarea></label><div class="chat-submit"><p class="chat-feedback" role="status" aria-live="polite"></p><button type="submit" class="primary" ${error?'disabled':''}>この端末に記録する</button></div></form><div class="chat-stream" aria-label="この現場の連絡履歴">${rows.map(x=>`<article class="chat-entry"><div class="chat-avatar" aria-hidden="true">${escape(x.author.slice(0,1))}</div><div class="chat-entry-body"><div class="chat-entry-meta"><strong>${escape(x.author)}</strong><time>${escape(x.date)}</time></div><p>${escape(x.message)}</p><small>記入者名は入力値です · 端末内の記録</small></div></article>`).join('')||'<div class="chat-empty">まだ連絡はありません。<br><span>最初の連絡を上の欄から記録できます。</span></div>'}</div></section>`;
  }
  root.renderSiteChat=renderSiteChat;
  root.SiteChatCore={read,validate,append,appendExclusive,todayJST,escape,key:KEY};
  if(root.document) root.document.addEventListener('submit',async function(e){
    const form=e.target;
    if(!form.matches?.('.site-chat-form')) return;
    e.preventDefault();
    if(form.dataset.saving==='yes')return;
    const feedback=form.querySelector('.chat-feedback'), button=form.querySelector('button[type=submit]');
    try {
      form.dataset.saving='yes';button.disabled=true;
      const values=Object.fromEntries(new FormData(form));
      values.site=form.dataset.site;
      form.dataset.operation ||= root.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await appendExclusive(root.localStorage,values,form.dataset.operation);
      if(!form.isConnected)return;
      const wrapper=form.closest('.site-chat'), fresh=root.document.createElement('div');
      fresh.innerHTML=renderSiteChat(values.site);
      wrapper.replaceWith(fresh.firstElementChild);
      const current=root.document.querySelector('.site-chat .chat-feedback');
      if(current)current.textContent='この端末に記録しました。';
    } catch(error){
      feedback.textContent=error.name==='QuotaExceededError'?'保存容量が不足しています。入力内容は残しています。':error.message || '保存できませんでした。入力内容は残しています。';
      form.dataset.saving='no';button.disabled=false;
    }
  });
})(globalThis);
