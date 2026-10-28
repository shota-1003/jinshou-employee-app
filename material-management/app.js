(function(){'use strict';
const client=new SharedInventory.Client({bridge:(method,params)=>portalSession.call(method,params),identity:()=>portalSession.identity(),queue:InventoryUploadQueue()});
let generation=0;
async function render(){const ticket=++generation,box=document.getElementById('materials');client.invalidate();box.replaceChildren();
 if(!portalSession.connected()){const p=document.createElement('p');p.textContent='資材管理を利用するにはログインしてください。';const a=document.createElement('a');a.href='./login.html';a.textContent='ログインする';box.append(p,a);return}
 const p=document.createElement('p');p.textContent='資材の総数を読み込んでいます…';box.append(p);
 try{const view=await client.load();if(ticket!==generation)return;if(!view.capabilities.manager)throw Error('総数の登録・更新は資材管理者が利用できます。');if(!view.capabilities.materialTotals)throw Error('総数管理の本番連携は準備中です。まだ登録・更新はできません。');await MaterialTotals.mount(box,{view,client})}catch(error){if(ticket===generation){box.replaceChildren();const message=document.createElement('p');message.setAttribute('role','alert');message.textContent=error.message;const retry=document.createElement('button');retry.textContent='再読み込み';retry.onclick=render;box.append(message,retry)}}
}
window.addEventListener('portal-session-ready',render);
})();
