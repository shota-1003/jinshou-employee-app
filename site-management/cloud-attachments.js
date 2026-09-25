(function(){
'use strict';
const sections=['写真','資料','工程表'];let dispose=null,mountAbort=null,generation=0;
const actor=()=>{const a=window.portalSession?.identity();return portalSession?.connected()&&a?.code?{kind:a.kind||'employee',code:a.code}:null};
const client=new SitePrivateAttachments.Client({records:siteSharedStore,identity:actor,bridge:(method,p)=>portalSession.call(method,p),queue:SitePrivateAttachments.indexedQueue()});
function mount(){
 mountAbort?.abort();mountAbort=null;if(dispose){dispose();dispose=null}generation++;
 if(page!=='detail'||!sections.includes(tab))return;
 const tabs=document.querySelector('#app .tabs');if(!tabs)return;
 // Legacy records lack authenticated owner information. Keep their stored originals,
 // but never expose that browser's file cards to another signed-in site member.
 while(tabs.nextSibling)tabs.nextSibling.remove();
 const box=document.createElement('section');box.className='panel';box.id='sharedAttachments';tabs.after(box);
 if(!actor()){box.textContent='ログイン後に、この現場で共有されたファイルを表示します。';return}
 const ticket=generation,site=sitePortalSiteKey(siteId),section=tab;
 box.textContent='共有ファイルを読み込んでいます…';
 mountAbort=new AbortController();const abort=mountAbort;
 mountPrivateAttachments(box,{client,site,section,signal:abort.signal}).then(fn=>{if(ticket!==generation||!box.isConnected){fn();return}dispose=fn}).catch(e=>{abort.abort();if(ticket===generation&&box.isConnected)box.textContent=e.message});
}
window.addEventListener('DOMContentLoaded',()=>{const previous=render;render=function(){previous();mount()};mount();if(window.SitePrivateAttachments&&window.mountPrivateAttachments)window.appSharedFeatures={...window.appSharedFeatures,'写真':true,'資料':true,'工程表':true}});
window.addEventListener('portal-session-ready',()=>{client.invalidate();mount()});
})();
