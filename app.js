'use strict';

// 迅翔興業 社員申請PWA。既存の「各種書類(株式会社迅翔興業様) の原本」スプレッドシートを
// 社員全員で直接共有編集する(誰が何を消したか分からなくなる)問題を避けるため、
// 各社員が自分の端末からSupabaseへ直接送信する構成にした。認証は新しいログイン基盤を
// 作らず、LINE連携(line_employee_links)と同じ強度の社員番号確認のみ(verify_employee_login)。

const SUPABASE_URL = 'https://tcxbtanumtuyfrqtjtvo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_UVAjFJSjIs7Sl2tMpLWRkQ_uyDw9eyW';
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

function getSession() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { return null; }
}
function setSession(session) { localStorage.setItem(STORAGE_KEY, JSON.stringify(session)); }
function clearSession() { localStorage.removeItem(STORAGE_KEY); }

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
  document.getElementById(`screen-${id}`).classList.add('active');
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

async function doSubmitLeave() {
  const session = getSession();
  const start = document.getElementById('leave-start').value;
  const end = document.getElementById('leave-end').value;
  const isHalf = document.getElementById('leave-half').checked;
  const days = document.getElementById('leave-days').value;
  const reason = document.getElementById('leave-reason').value.trim();
  const note = document.getElementById('leave-note').value.trim();
  hideError('leave-error');

  if (!start || !end || !days || !reason) {
    showError('leave-error', '開始日・終了日・日数・事由は必須です。');
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
      p_requested_days: Number(days),
      p_reason: reason,
      p_note: note || null,
    });
    document.getElementById('done-message').textContent = '有給休暇申請を受け付けました。承認をお待ちください。';
    showScreen('done');
    ['leave-start', 'leave-end', 'leave-days', 'leave-reason', 'leave-note'].forEach((id) => { document.getElementById(id).value = ''; });
    document.getElementById('leave-half').checked = false;
  } catch (e) {
    showError('leave-error', '送信に失敗しました。もう一度お試しください。');
  } finally {
    btn.disabled = false;
  }
}

async function doSubmitExpense() {
  const session = getSession();
  const date = document.getElementById('expense-date').value;
  const store = document.getElementById('expense-store').value.trim();
  const amount = document.getElementById('expense-amount').value;
  const site = document.getElementById('expense-site').value.trim();
  const purpose = document.getElementById('expense-purpose').value.trim();
  const payment = document.getElementById('expense-payment').value;
  hideError('expense-error');

  if (!date || !store || !amount) {
    showError('expense-error', '日付・店舗名・金額は必須です。');
    return;
  }

  const btn = document.getElementById('expense-submit');
  btn.disabled = true;
  try {
    await rpc('submit_manual_expense_request', {
      p_employee_code: session.employeeCode,
      p_document_date: date,
      p_store: store,
      p_amount: Number(amount),
      p_site_name: site || null,
      p_purpose: purpose || null,
      p_payment_method: payment,
    });
    document.getElementById('done-message').textContent = '経費申請を受け付けました。承認をお待ちください。';
    showScreen('done');
    ['expense-date', 'expense-store', 'expense-amount', 'expense-site', 'expense-purpose'].forEach((id) => { document.getElementById(id).value = ''; });
  } catch (e) {
    showError('expense-error', '送信に失敗しました。もう一度お試しください。');
  } finally {
    btn.disabled = false;
  }
}

function init() {
  document.getElementById('login-btn').addEventListener('click', doLogin);
  document.getElementById('login-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('logout-btn').addEventListener('click', () => { clearSession(); showScreen('login'); });
  document.getElementById('leave-submit').addEventListener('click', doSubmitLeave);
  document.getElementById('expense-submit').addEventListener('click', doSubmitExpense);

  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => {
      const target = el.getAttribute('data-nav');
      if (el.classList.contains('disabled')) return;
      if (target === 'menu') { enterMenu(); return; }
      showScreen(target);
    });
  });

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
