(function(){
'use strict';
// Legacy browser records and IndexedDB files do not carry a reliable owner ID.
// A whole-device export could disclose another person's records after account switching.
window.siteDataBackup=async()=>{const status=document.getElementById('backupStatus');if(status)status.textContent='この端末の旧データは本人別に分離されていないため、一括ダウンロードできません。管理者に保全を依頼してください。';return false};
function open(){show('<h2>データ保全</h2><p>共有クラウドの現場記録・添付ファイル・受講記録は、この端末の控えに含まれません。</p><p>この端末に残る旧データは本人別に分離されていません。別の利用者の記録が混ざる可能性があるため、一括ダウンロードは提供していません。旧データの保全や移行は管理者に依頼してください。</p><p id="backupStatus" role="status"></p><button class="secondary" onclick="closeModal()">閉じる</button>')}
window.addEventListener('DOMContentLoaded',()=>{const b=document.createElement('button');b.className='secondary';b.textContent='データ保全';b.onclick=open;document.querySelector('main .top').append(b);if(mainStorageError){const notice=document.createElement('div');notice.className='notice';notice.setAttribute('role','alert');notice.textContent=mainStorageError;document.querySelector('main .top').after(notice)}});
})();