'use strict';

// 迅翔興業 社員ポータルPWA。既存の「各種書類(株式会社迅翔興業様) の原本」スプレッドシートを
// 社員全員で直接共有編集する(誰が何を消したか分からなくなる)問題を避けるため、
// 各社員が自分の端末からSupabaseへ直接送信する構成にした。認証は新しいログイン基盤を
// 作らず、LINE連携(line_employee_links)と同じ強度の社員番号確認のみ(verify_employee_login)。
// ログインは端末に保存し、本人が明示的にログアウトするまで自動ログインを維持する。

const SUPABASE_URL = 'https://tcxbtanumtuyfrqtjtvo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_UVAjFJSjIs7Sl2tMpLWRkQ_uyDw9eyW';
const N8N_BASE_URL = 'https://shota1003.app.n8n.cloud';
const STORAGE_KEY = 'jinshou_employee_session';

async function rpc(name, params) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `通信エラー(${res.status})`);
  return text ? JSON.parse(text) : null;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 領収書写真をn8n「App Receipt Upload」経由でDriveへアップロードする。このワークフローは
// 秘密情報(Gateway Shared Secret)を要求せず、内部でemployee_codeをSupabaseへ照会して
// 本人確認する(ブラウザに秘密情報を埋め込まないための設計、詳細はn8n/app-receipt-upload.json)。
async function uploadReceiptPhoto(employeeCode, file) {
  const base64 = await fileToBase64(file);
  const res = await fetch(`${N8N_BASE_URL}/webhook/app-receipt-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeCode, fileName: file.name || 'receipt.jpg', mimeType: file.type || 'image/jpeg', base64 }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.error || !json.driveFileId) throw new Error((json && json.error) || 'アップロードに失敗しました');
  return json;
}

function getSession() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { return null; }
}
function setSession(session) { localStorage.setItem(STORAGE_KEY, JSON.stringify(session)); }
function clearSession() { localStorage.removeItem(STORAGE_KEY); }

const SCREEN_ENTER_HOOKS = {};

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
  document.getElementById(`screen-${id}`).classList.add('active');
  if (SCREEN_ENTER_HOOKS[id]) SCREEN_ENTER_HOOKS[id]();
}

function showError(elId, message) {
  const el = document.getElementById(elId);
  el.textContent = message;
  el.classList.add('show');
}
function hideError(elId) {
  document.getElementById(elId).classList.remove('show');
}

async function doLogin() {
  const code = document.getElementById('login-code').value.trim();
  hideError('login-error');
  if (!code) return;
  try {
    const rows = await rpc('verify_employee_login', { p_employee_code: code });
    if (!rows || rows.length === 0) {
      showError('login-error', '社員番号が確認できませんでした。');
      return;
    }
    const emp = rows[0];
    setSession({ employeeCode: code, employeeId: emp.employee_id, employeeName: emp.employee_name, requestRole: emp.request_role });
    enterMenu();
  } catch (e) {
    showError('login-error', '通信エラーが発生しました。電波の良い場所でもう一度お試しください。');
  }
}

function enterMenu() {
  const session = getSession();
  document.getElementById('menu-greeting').textContent = `こんにちは、${session.employeeName}さん`;
  showScreen('menu');
}

// ---------- 有給休暇申請 ----------

function updateLeaveDaysDisplay() {
  const start = document.getElementById('leave-start').value;
  const end = document.getElementById('leave-end').value;
  const isHalf = document.getElementById('leave-half').checked;
  const box = document.getElementById('leave-days-box');
  if (!start || !end) { box.textContent = '日数: -'; return; }
  if (end < start) { box.textContent = '終了日は開始日以降にしてください'; return; }
  const days = isHalf && start === end ? 0.5 : (new Date(end) - new Date(start)) / 86400000 + 1;
  box.textContent = `日数: ${days}日`;
}

async function loadLeaveBalance() {
  const session = getSession();
  const box = document.getElementById('leave-balance-box');
  box.textContent = '残日数を確認中...';
  try {
    const rows = await rpc('get_leave_balance', { p_employee_code: session.employeeCode });
    const b = rows && rows[0];
    if (!b || !b.has_initial_grant) {
      box.textContent = '現在の有給残日数: 未登録(会社側で登録され次第表示されます)';
    } else {
      box.textContent = `現在の有給残日数: ${b.current_balance}日`;
    }
  } catch (e) {
    box.textContent = '';
  }
}

async function doSubmitLeave() {
  const session = getSession();
  const start = document.getElementById('leave-start').value;
  const end = document.getElementById('leave-end').value;
  const isHalf = document.getElementById('leave-half').checked;
  const reason = document.getElementById('leave-reason').value.trim();
  const note = document.getElementById('leave-note').value.trim();
  hideError('leave-error');

  if (!start || !end || !reason) {
    showError('leave-error', '開始日・終了日・事由は必須です。');
    return;
  }
  if (end < start) {
    showError('leave-error', '終了日は開始日以降にしてください。');
    return;
  }

  const btn = document.getElementById('leave-submit');
  btn.disabled = true;
  try {
    await rpc('submit_paid_leave_request', {
      p_employee_code: session.employeeCode,
      p_start_date: start,
      p_end_date: end,
      p_is_half_day: isHalf,
      p_reason: reason,
      p_note: note || null,
    });
    document.getElementById('done-message').textContent = '有給休暇申請を受け付けました。承認をお待ちください。';
    showScreen('done');
    ['leave-start', 'leave-end', 'leave-reason', 'leave-note'].forEach((id) => { document.getElementById(id).value = ''; });
    document.getElementById('leave-half').checked = false;
    updateLeaveDaysDisplay();
  } catch (e) {
    showError('leave-error', '送信に失敗しました。もう一度お試しください。');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 経費立替申請(複数明細) ----------

let expenseItemSeq = 0;
const expenseItemState = new Map(); // itemId -> { driveFileId, driveFileUrl, uploading }

function addExpenseItem() {
  const template = document.getElementById('expense-item-template');
  const clone = template.content.cloneNode(true);
  const itemId = `item-${++expenseItemSeq}`;
  const card = clone.querySelector('.expense-item-card');
  card.dataset.itemId = itemId;
  clone.querySelector('.item-label').textContent = `明細${expenseItemSeq}`;
  expenseItemState.set(itemId, { driveFileId: null, driveFileUrl: null, uploading: false });

  clone.querySelector('.remove-item-btn').addEventListener('click', () => {
    document.querySelector(`[data-item-id="${itemId}"]`).remove();
    expenseItemState.delete(itemId);
    updateExpenseTotal();
  });

  const photoInput = clone.querySelector('.item-photo-input');
  const preview = clone.querySelector('.item-photo-preview');
  const status = clone.querySelector('.photo-status');
  photoInput.addEventListener('change', async () => {
    const file = photoInput.files[0];
    if (!file) return;
    preview.src = URL.createObjectURL(file);
    preview.style.display = 'block';
    status.textContent = 'アップロード中...';
    status.className = 'photo-status uploading';
    const state = expenseItemState.get(itemId);
    state.uploading = true;
    try {
      const session = getSession();
      const result = await uploadReceiptPhoto(session.employeeCode, file);
      state.driveFileId = result.driveFileId;
      state.driveFileUrl = result.driveFileUrl;
      status.textContent = 'アップロード完了';
      status.className = 'photo-status ok';
    } catch (e) {
      status.textContent = 'アップロードに失敗しました。もう一度お試しください。';
      status.className = 'photo-status err';
    } finally {
      state.uploading = false;
    }
  });

  clone.querySelector('.item-amount').addEventListener('input', updateExpenseTotal);

  document.getElementById('expense-item-list').appendChild(clone);
  updateExpenseTotal();
}

function updateExpenseTotal() {
  const cards = document.querySelectorAll('.expense-item-card');
  let total = 0;
  cards.forEach((card) => {
    const amount = Number(card.querySelector('.item-amount').value || 0);
    total += amount;
  });
  document.getElementById('expense-total-count').textContent = `${cards.length}件`;
  document.getElementById('expense-total-amount').textContent = `${total.toLocaleString()}円`;
}

function resetExpenseForm() {
  document.getElementById('expense-item-list').innerHTML = '';
  expenseItemState.clear();
  expenseItemSeq = 0;
  addExpenseItem();
}

async function doSubmitExpense() {
  const session = getSession();
  hideError('expense-error');
  const cards = Array.from(document.querySelectorAll('.expense-item-card'));

  if (cards.length === 0) {
    showError('expense-error', '明細を1件以上追加してください。');
    return;
  }

  const items = [];
  for (const card of cards) {
    const itemId = card.dataset.itemId;
    const state = expenseItemState.get(itemId);
    const date = card.querySelector('.item-date').value;
    const store = card.querySelector('.item-store').value.trim();
    const amount = Number(card.querySelector('.item-amount').value || 0);
    const site = card.querySelector('.item-site').value.trim();
    const purpose = card.querySelector('.item-purpose').value.trim();
    const note = card.querySelector('.item-note').value.trim();
    const label = card.querySelector('.item-label').textContent;

    if (state.uploading) { showError('expense-error', `${label}: 写真のアップロード中です。少しお待ちください。`); return; }
    if (!state.driveFileId) { showError('expense-error', `${label}: 領収書の写真を添付してください。`); return; }
    if (!date || !store || !amount) { showError('expense-error', `${label}: 利用日・支払先・金額は必須です。`); return; }

    items.push({
      document_date: date, store, amount, site_name: site || null, purpose: purpose || null,
      drive_file_id: state.driveFileId, drive_file_url: state.driveFileUrl, note: note || null,
    });
  }

  const btn = document.getElementById('expense-submit');
  btn.disabled = true;
  try {
    const result = await rpc('submit_expense_claim', { p_employee_code: session.employeeCode, p_items: items });
    const r = result && result[0];
    document.getElementById('done-message').textContent = `経費申請を受け付けました(${r ? r.item_count : items.length}件、合計${r ? Number(r.total_amount).toLocaleString() : ''}円)。承認をお待ちください。`;
    showScreen('done');
    resetExpenseForm();
  } catch (e) {
    showError('expense-error', '送信に失敗しました。もう一度お試しください。');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 会議申請 ----------

async function doSubmitMeeting() {
  const session = getSession();
  const date = document.getElementById('meeting-date').value;
  const place = document.getElementById('meeting-place').value.trim();
  const headcount = document.getElementById('meeting-headcount').value;
  const hasMeal = document.getElementById('meeting-meal').checked;
  const content = document.getElementById('meeting-content').value.trim();
  const amount = document.getElementById('meeting-amount').value;
  const receive = document.getElementById('meeting-receive').value;
  hideError('meeting-error');

  if (!date || !content) {
    showError('meeting-error', '会議日・会議内容は必須です。');
    return;
  }

  const btn = document.getElementById('meeting-submit');
  btn.disabled = true;
  try {
    await rpc('submit_meeting_request', {
      p_employee_code: session.employeeCode,
      p_meeting_date: date,
      p_place: place || null,
      p_headcount: headcount ? Number(headcount) : null,
      p_has_meal: hasMeal,
      p_content: content,
      p_amount: amount ? Number(amount) : null,
      p_receive_method: receive,
    });
    document.getElementById('done-message').textContent = '会議申請を受け付けました。承認をお待ちください。';
    showScreen('done');
    ['meeting-date', 'meeting-place', 'meeting-headcount', 'meeting-content', 'meeting-amount'].forEach((id) => { document.getElementById(id).value = ''; });
    document.getElementById('meeting-meal').checked = false;
  } catch (e) {
    showError('meeting-error', '送信に失敗しました。もう一度お試しください。');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 申請履歴 ----------

const REQUEST_TYPE_LABEL = { paid_leave: '有給休暇申請', expense_reimbursement: '経費立替申請', meeting: '会議申請', other: 'その他' };
const STATUS_LABEL = {
  ready_for_review: '確認中', waiting_employee_info: '確認中', needs_review: '確認中', stopped: '処理停止',
  waiting_approval: '承認待ち', approved: '承認済み', rejected: '却下', on_hold: '保留',
  waiting_payment: '支払待ち', paid: '支払済み', cancelled: '取消',
};

async function loadHistory() {
  const session = getSession();
  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_requests', { p_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) {
      listEl.innerHTML = '<div class="hint">まだ申請がありません。</div>';
      return;
    }
    listEl.innerHTML = '';
    rows.forEach((r) => {
      const div = document.createElement('div');
      div.className = 'history-item';
      const dateStr = new Date(r.requested_at).toLocaleDateString('ja-JP');
      const amountStr = r.amount != null ? `${Number(r.amount).toLocaleString()}円` : '';
      const statusClass = ['approved', 'paid'].includes(r.status) ? 'done' : (['rejected', 'cancelled'].includes(r.status) ? 'rejected' : '');
      div.innerHTML = `
        <div class="row1"><span>${REQUEST_TYPE_LABEL[r.request_type] || r.request_type}</span><span>${amountStr}</span></div>
        <div class="row2">${dateStr}　${r.summary || ''}</div>
        <span class="status-badge ${statusClass}">${STATUS_LABEL[r.status] || r.status}</span>
      `;
      listEl.appendChild(div);
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// ---------- 初期化 ----------

function init() {
  document.getElementById('login-btn').addEventListener('click', doLogin);
  document.getElementById('login-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('logout-btn').addEventListener('click', () => { clearSession(); showScreen('login'); });

  document.getElementById('leave-submit').addEventListener('click', doSubmitLeave);
  ['leave-start', 'leave-end', 'leave-half'].forEach((id) => {
    document.getElementById(id).addEventListener('change', updateLeaveDaysDisplay);
  });

  document.getElementById('expense-add-item').addEventListener('click', addExpenseItem);
  document.getElementById('expense-submit').addEventListener('click', doSubmitExpense);

  document.getElementById('meeting-submit').addEventListener('click', doSubmitMeeting);

  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => {
      const target = el.getAttribute('data-nav');
      if (el.disabled) return;
      if (target === 'menu') { enterMenu(); return; }
      showScreen(target);
    });
  });

  SCREEN_ENTER_HOOKS.leave = () => { updateLeaveDaysDisplay(); loadLeaveBalance(); };
  SCREEN_ENTER_HOOKS.expense = () => { resetExpenseForm(); hideError('expense-error'); };
  SCREEN_ENTER_HOOKS.history = loadHistory;

  const session = getSession();
  if (session && session.employeeId) {
    enterMenu();
  } else {
    showScreen('login');
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
