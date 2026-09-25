(function(root){'use strict';
function summarize(view,{from='',to='',site=view.site}={}){
 const moves=view.moves.filter(m=>!site||String(m.site)===String(site)),reversed=new Set(moves.filter(m=>m.type==='reverse').map(m=>m.reverse));
 const active=moves.filter(m=>m.type!=='reverse'&&!reversed.has(m.id));
 const demand=(view.demands||[]).filter(d=>!site||String(d.site)===String(site));
 const rows=view.items.map(i=>{const itemMoves=active.filter(m=>m.item===i.id),losses=view.losses.filter(l=>l.item===i.id&&(!site||String(l.site)===String(site))),pending=losses.filter(l=>!l.settledAt).reduce((n,l)=>n+l.qty,0),wanted=demand.flatMap(d=>d.lines).filter(l=>l.item===i.id).reduce((n,l)=>n+l.qty,0),sent=itemMoves.filter(m=>m.type==='dispatch').reduce((n,m)=>n+m.qty,0);return{item:i.id,name:i.name,unit:i.unit,wanted,sent,needed:Math.max(0,wanted-sent),held:i.held||0,pending,unclassified:Math.max(0,(i.held||0)-pending),created:i.createdAt||'',lastPurchase:itemMoves.filter(m=>m.type==='purchase').map(m=>m.date).sort().at(-1)||'',lastChange:itemMoves.map(m=>m.date).sort().at(-1)||'',loss:losses.filter(l=>{const date=(l.date||l.reportedAt||'').slice(0,10);return(!from||date>=from)&&(!to||date<=to)}).reduce((n,l)=>n+l.qty,0)}});
 const zones=new Map();for(const o of view.orders.filter(o=>!site||String(o.site)===String(site))){const key=o.site+'|'+(o.zone||'工区なし');if(!zones.has(key))zones.set(key,{site:o.site,zone:o.zone||'工区なし',ordered:0,ready:0,shipped:0});const z=zones.get(key);z.ordered++;if(o.status==='準備完了')z.ready++;if(o.status==='持出済み')z.shipped++}
 return{rows,zones:[...zones.values()],canClose:rows.every(r=>r.unclassified===0),hasPending:rows.some(r=>r.pending>0)};
}
root.SharedInventoryAggregates={summarize};if(typeof module!=='undefined')module.exports=root.SharedInventoryAggregates;
})(typeof window==='undefined'?globalThis:window);
