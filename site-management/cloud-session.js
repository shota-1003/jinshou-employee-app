(function(){
'use strict';
const routes={site_records_list:'recordsList',site_record_save:'recordSave'};
window.siteSharedStore=new SiteSharedRecords.SharedRecords({
 identity:()=>{const a=window.portalSession?.identity();if(!window.portalSession?.connected()||!a?.code)return null;const kind=a.kind||'employee';return ['employee','worker'].includes(kind)?{kind,code:a.code}:null},
 rpc:(method,params)=>{if(!routes[method])throw Error('共有操作が正しくありません');return portalSession.call(routes[method],params)},
 queue:SiteSharedRecords.indexedQueue()
});
window.addEventListener('portal-session-ready',()=>siteSharedStore.clear());
})();
