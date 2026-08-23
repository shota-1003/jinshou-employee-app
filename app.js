'use strict';

// 迅翔興業 社員ポータルPWA。既存の「各種書類(株式会社迅翔興業様) の原本」スプレッドシートを
// 社員全員で直接共有編集する(誰が何を消したか分からなくなる)問題を避けるため、
// 各社員が自分の端末からSupabaseへ直接送信する構成にした。
//
// 認証(2026-08-22改訂): 社員番号だけでの本人確認はセキュリティ上不十分という指摘を受け、
// 暗証番号(4〜6桁、pgcryptoでサーバー側ハッシュ化、平文は一切保存しない)を追加した。
// 「端末記憶」と「認証情報」を分離する設計: localStorageには社員番号だけを覚えさせ
// (=次回起動時に社員番号入力を省略するため)、実際の本人確認(暗証番号照合)は毎回
// サーバー側で行う。認証成功後の「ログイン状態」はsessionStorageに置き、アプリを
// 完全に開き直すたび(タブを閉じる・PWAを終了する等)に暗証番号の再入力を求める
// (ページを更新しただけの間は再入力不要)。

const SUPABASE_URL = 'https://tcxbtanumtuyfrqtjtvo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_UVAjFJSjIs7Sl2tMpLWRkQ_uyDw9eyW';
const N8N_BASE_URL = 'https://shota1003.app.n8n.cloud';
const SESSION_KEY = 'jinshou_employee_session'; // sessionStorage(タブを閉じると消える)
const REMEMBERED_CODE_KEY = 'jinshou_remembered_employee_code'; // localStorage(端末記憶)

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
  if (!res.ok) {
    // SupabaseのRPCエラー(RAISE EXCEPTIONのメッセージ)はJSONで返るため、
    // 表示用に読みやすいメッセージだけを取り出す(生JSONをそのまま見せない)。
    let message = `通信エラー(${res.status})`;
    try { const parsed = JSON.parse(text); if (parsed && parsed.message) message = parsed.message; } catch { /* JSONでなければそのまま */ }
    throw new Error(message);
  }
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
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function setSession(session) { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); }
function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(REMEMBERED_CODE_KEY);
}
function getRememberedCode() { return localStorage.getItem(REMEMBERED_CODE_KEY); }
function setRememberedCode(code) { localStorage.setItem(REMEMBERED_CODE_KEY, code); }

const SCREEN_ENTER_HOOKS = {};

// 下部ナビは5つ(ホーム/申請/お知らせ/履歴/自分)。そこから遷移するサブ画面にいる間も、
// 元のタブが点灯したままになるようにマッピングする。
const BOTTOM_NAV_MAP = {
  menu: 'menu',
  'menu-apply': 'menu-apply', leave: 'menu-apply', 'expense-advance': 'menu-apply', 'expense-company': 'menu-apply',
  meeting: 'menu-apply', 'supply-request': 'menu-apply', 'qual-submit': 'menu-apply',
  announcements: 'announcements',
  history: 'history',
  myinfo: 'myinfo', 'leave-history': 'myinfo', 'my-supply': 'myinfo', 'my-qual': 'myinfo',
  'my-change-requests': 'myinfo', 'profile-edit': 'myinfo', 'anon-consult': 'myinfo', 'anon-submit': 'myinfo',
  'anon-done': 'myinfo', 'anon-thread': 'myinfo',
};

// 絵文字を廃止し線画SVG(icons.js)へ統一するための一括反映。静的HTML内の
// <span class="icon-slot" data-icon="name">を実際のSVGへ差し替える。back-linkは
// 個別にdata-iconを書かなくても済むよう、ここでまとめて先頭にアイコンを付ける。
function hydrateIcons(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon);
    el.removeAttribute('data-icon');
  });
  scope.querySelectorAll('.back-link:not([data-hydrated])').forEach((el) => {
    el.setAttribute('data-hydrated', '1');
    el.insertAdjacentHTML('afterbegin', icon('chevron-left'));
  });
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
  document.getElementById(`screen-${id}`).classList.add('active');
  const preAuthScreens = ['login', 'pin-entry', 'pin-register'];
  document.getElementById('bottom-nav').style.display = preAuthScreens.includes(id) ? 'none' : 'flex';
  document.querySelectorAll('.bottom-nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-nav') === (BOTTOM_NAV_MAP[id] || id));
  });
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

let pendingLoginCode = null; // 社員番号入力〜暗証番号入力/登録の間だけ保持する一時変数

// 起動時: 端末が社員番号を覚えていれば暗証番号入力画面へ、覚えていなければ社員番号入力画面へ。
async function startLoginFlow() {
  const remembered = getRememberedCode();
  if (!remembered) { showScreen('login'); return; }

  pendingLoginCode = remembered;
  hideError('pin-entry-error');
  document.getElementById('pin-entry-name').textContent = '確認中...';
  showScreen('pin-entry');
  try {
    const rows = await rpc('check_employee_has_pin', { p_employee_code: remembered });
    const info = rows && rows[0];
    if (!info || !info.exists_and_active) {
      // 退職・無効化された社員番号を端末が覚えていた場合は、社員番号入力からやり直させる。
      clearSession();
      showScreen('login');
      return;
    }
    if (!info.has_pin) {
      showScreen('pin-register');
      document.getElementById('pin-register-name').textContent = `${info.employee_name}さん`;
      return;
    }
    document.getElementById('pin-entry-name').textContent = `${info.employee_name}さん`;
  } catch (e) {
    document.getElementById('pin-entry-name').textContent = '';
    showError('pin-entry-error', '通信エラーが発生しました。');
  }
}

async function doSubmitEmployeeCode() {
  const code = document.getElementById('login-code').value.trim();
  hideError('login-error');
  if (!code) return;
  try {
    const rows = await rpc('check_employee_has_pin', { p_employee_code: code });
    const info = rows && rows[0];
    if (!info || !info.exists_and_active) {
      showError('login-error', '社員番号が確認できませんでした。');
      return;
    }
    pendingLoginCode = code;
    setRememberedCode(code);
    if (info.has_pin) {
      hideError('pin-entry-error');
      document.getElementById('pin-entry-name').textContent = `${info.employee_name}さん`;
      showScreen('pin-entry');
    } else {
      hideError('pin-register-error');
      document.getElementById('pin-register-name').textContent = `${info.employee_name}さん`;
      showScreen('pin-register');
    }
  } catch (e) {
    showError('login-error', '通信エラーが発生しました。電波の良い場所でもう一度お試しください。');
  }
}

async function doVerifyPin() {
  const pin = document.getElementById('pin-entry-code').value.trim();
  hideError('pin-entry-error');
  if (!pin) return;
  const btn = document.getElementById('pin-entry-submit');
  btn.disabled = true;
  try {
    const rows = await rpc('verify_employee_pin', { p_employee_code: pendingLoginCode, p_pin: pin });
    if (!rows || rows.length === 0) {
      showError('pin-entry-error', '暗証番号が違います。');
      document.getElementById('pin-entry-code').value = '';
      return;
    }
    const emp = rows[0];
    setSession({ employeeCode: pendingLoginCode, employeeId: emp.out_employee_id, employeeName: emp.out_employee_name, requestRole: emp.out_request_role });
    document.getElementById('pin-entry-code').value = '';
    enterMenu();
  } catch (e) {
    showError('pin-entry-error', e.message);
  } finally {
    btn.disabled = false;
  }
}

async function doRegisterPin() {
  const pin = document.getElementById('pin-register-code').value.trim();
  const pinConfirm = document.getElementById('pin-register-confirm').value.trim();
  hideError('pin-register-error');

  if (!/^[0-9]{4,6}$/.test(pin)) {
    showError('pin-register-error', '暗証番号は4〜6桁の数字で入力してください。');
    return;
  }
  if (pin !== pinConfirm) {
    showError('pin-register-error', '確認用の暗証番号が一致しません。');
    return;
  }

  const btn = document.getElementById('pin-register-submit');
  btn.disabled = true;
  try {
    const rows = await rpc('register_employee_pin', { p_employee_code: pendingLoginCode, p_pin: pin });
    const emp = rows[0];
    setSession({ employeeCode: pendingLoginCode, employeeId: emp.out_employee_id, employeeName: emp.out_employee_name, requestRole: emp.out_request_role });
    document.getElementById('pin-register-code').value = '';
    document.getElementById('pin-register-confirm').value = '';
    enterMenu();
  } catch (e) {
    showError('pin-register-error', e.message);
  } finally {
    btn.disabled = false;
  }
}

function switchEmployee() {
  clearSession();
  pendingLoginCode = null;
  document.getElementById('login-code').value = '';
  showScreen('login');
}

async function loadHomeLeaveStats(balanceElId, usedElId) {
  const session = getSession();
  try {
    const rows = await rpc('get_leave_summary', { p_employee_code: session.employeeCode });
    const b = rows && rows[0];
    document.getElementById(balanceElId).textContent = b && b.has_initial_grant ? `${b.current_balance}日` : '未登録';
    document.getElementById(usedElId).textContent = b ? `${b.used_this_year}日` : '-';
  } catch (e) { /* 表示できなくても致命的ではないため無視 */ }
}

function greetingWord() {
  const h = new Date().getHours();
  if (h < 11) return 'おはようございます';
  if (h < 18) return 'こんにちは';
  return 'お疲れさまです';
}

function enterMenu() {
  const session = getSession();
  document.getElementById('menu-greeting-hi').textContent = greetingWord();
  document.getElementById('menu-greeting-name').textContent = `${session.employeeName}さん`;
  const showAdmin = session.requestRole === 'executive';
  const bannerArea = document.getElementById('admin-banner-area');
  bannerArea.innerHTML = showAdmin ? `
    <button type="button" class="main-menu-card" data-nav="admin-dashboard" style="width:100%; flex-direction:row; align-items:center; gap:14px; margin-top:8px;">
      <span class="main-menu-card-icon">${icon('shield')}</span>
      <span style="text-align:left;">
        <span class="main-menu-label" style="display:block;">管理者ダッシュボード</span>
        <span class="main-menu-desc">承認待ち・社員管理をまとめて確認</span>
      </span>
      <span style="margin-left:auto; color:var(--text-faint);">${icon('chevron-right')}</span>
    </button>
  ` : '';
  bannerArea.querySelectorAll('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => showScreen(el.getAttribute('data-nav')));
  });
  checkAnonUnreadBadge().then(loadTodayList);
  loadAnnounceBanner();
  loadHomeAnnouncePreview();
  showScreen('menu');
}

// ホーム画面「会社からのお知らせ」の最新2〜3件ミニプレビュー。
async function loadHomeAnnouncePreview() {
  const session = getSession();
  const area = document.getElementById('home-announce-block');
  area.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_announcements', { p_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { area.innerHTML = '<div class="hint">お知らせはありません。</div>'; return; }
    const top = rows.slice(0, 3);
    area.innerHTML = top.map((a) => `
      <div class="home-announce-item" data-id="${a.id}">
        <span class="home-announce-dot ${a.importance === 'important' ? 'important' : (!a.is_read ? 'unread normal-imp' : '')}"></span>
        <div class="home-announce-body2">
          <div class="home-announce-title-row">
            ${a.importance === 'important' ? '<span class="home-announce-tag important">重要</span>' : '<span class="home-announce-tag normal">お知らせ</span>'}
            <span class="home-announce-title">${a.title}</span>
          </div>
          <div class="home-announce-date">${new Date(a.created_at).toLocaleDateString('ja-JP')}</div>
        </div>
      </div>
    `).join('');
    area.querySelectorAll('.home-announce-item').forEach((el) => {
      el.addEventListener('click', () => showScreen('announcements'));
    });
  } catch (e) {
    area.innerHTML = '';
  }
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
    const rows = await rpc('get_leave_summary', { p_employee_code: session.employeeCode });
    const b = rows && rows[0];
    document.getElementById('leave-summary-used').textContent = b ? `${b.used_this_year}日` : '-';
    document.getElementById('leave-summary-count').textContent = b ? `${b.taken_count_this_year}回` : '-';
    if (!b || !b.has_initial_grant) {
      document.getElementById('leave-summary-balance').textContent = '未登録';
      document.getElementById('leave-summary-note').textContent = '正式な有給残日数はまだ会社側で登録されていません。';
      box.textContent = '';
    } else {
      document.getElementById('leave-summary-balance').textContent = `${b.current_balance}日`;
      document.getElementById('leave-summary-note').textContent = '';
      box.textContent = `申請後の残日数見込み: 計算中`;
    }
  } catch (e) {
    box.textContent = '';
  }
}

async function loadLeaveHistory() {
  const session = getSession();
  const listEl = document.getElementById('leave-history-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_leave_taken_history', { p_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) {
      listEl.innerHTML = '<div class="hint">承認済みの有給取得履歴はまだありません。</div>';
      return;
    }
    listEl.innerHTML = '';
    rows.forEach((r) => {
      const div = document.createElement('div');
      div.className = 'history-item';
      div.innerHTML = `
        <div class="row1"><span>${r.start_date} 〜 ${r.end_date}</span><span>${r.requested_days}日</span></div>
        <div class="row2">${r.reason || ''}${r.is_half_day ? '(半休)' : ''}</div>
        <span class="status-badge done">承認済み</span>
      `;
      listEl.appendChild(div);
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
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

// ---------- 経費立替申請 / 会社経費登録(複数明細、共通画面) ----------

const EXPENSE_PAYMENT_OPTIONS = {
  employee_advance: ['現金', 'クレジットカード', '電子マネー', '振込', 'その他'],
  company_expense: ['会社現金', '法人カード', '会社口座', 'その他'],
};
const EXPENSE_SCREEN_TEXT = {
  employee_advance: {
    title: '経費立替申請',
    hint: '自分で支払った会社経費を申請します(後日会社から返金)。領収書の写真が必須です。複数の領収書をまとめて1回の申請にできます。',
  },
  company_expense: {
    title: '会社経費登録',
    hint: '会社(現金・法人カード・会社口座等)が既に支払った経費を登録します。社員への返金は発生しません。領収書の写真が必須です。',
  },
};

let currentExpenseCategory = 'employee_advance';
let expenseItemSeq = 0;
const expenseItemState = new Map(); // itemId -> { driveFileId, driveFileUrl, uploading, siteId }

async function populateVendorList() {
  try {
    const rows = await rpc('search_vendors', { p_query: null });
    document.getElementById('vendor-list').innerHTML = rows.map((v) => `<option value="${v.company_name}">`).join('');
  } catch (e) { /* 取引先候補が引けなくても自由入力は継続できる */ }
}

function enterExpenseScreen(category) {
  currentExpenseCategory = category;
  const text = EXPENSE_SCREEN_TEXT[category];
  document.getElementById('expense-screen-title').textContent = text.title;
  document.getElementById('expense-screen-hint').textContent = text.hint;
  resetExpenseForm();
  hideError('expense-error');
  populateVendorList();
  showScreen('expense');
}

async function populateSiteSelect(selectEl, query) {
  try {
    const session = getSession();
    const rows = await rpc('search_sites', { p_query: query || null, p_employee_code: session ? session.employeeCode : null });
    const current = selectEl.value;
    const recent = rows.filter((s) => s.recently_used);
    const others = rows.filter((s) => !s.recently_used);
    const opt = (s) => `<option value="${s.id}" data-name="${s.site_name}">${s.site_name}</option>`;
    let html = '<option value="">選択してください</option>';
    if (recent.length > 0) html += `<optgroup label="最近使った現場">${recent.map(opt).join('')}</optgroup>`;
    html += (recent.length > 0 ? '<optgroup label="現場一覧">' : '') + others.map(opt).join('') + (recent.length > 0 ? '</optgroup>' : '');
    selectEl.innerHTML = html;
    if (current && rows.some((s) => String(s.id) === current)) selectEl.value = current;
  } catch (e) { /* 現場マスターが引けない場合は空のまま(自由入力は不可、要確認扱い) */ }
}

// 過去の入力履歴から現場・使用目的の候補を提示する(タップで入力欄へ反映するだけで、
// 自動で確定・送信はしない。候補が無ければ何も表示しない=AIが推測で埋めることはない)。
async function showExpenseSuggestion(card, storeName) {
  const area = card.querySelector('.item-suggest-area');
  area.style.display = 'none';
  area.innerHTML = '';
  if (!storeName) return;
  try {
    const rows = await rpc('suggest_expense_context', { p_store_name: storeName });
    const s = rows && rows[0];
    if (!s || !s.site_id) return;
    area.innerHTML = `
      <div class="item-suggest-label">前回の入力から候補(タップで入力欄へ反映、必ず内容を確認してください)</div>
      <button type="button" class="item-suggest-chip">${icon('info')}<span>現場候補: ${s.site_name}／用途候補: ${s.purpose}${s.vendor_name ? `／取引先候補: ${s.vendor_name}` : ''}</span></button>
    `;
    area.style.display = 'block';
    area.querySelector('.item-suggest-chip').addEventListener('click', async () => {
      const siteSelect = card.querySelector('.item-site-select');
      await populateSiteSelect(siteSelect, '');
      siteSelect.value = String(s.site_id);
      card.querySelector('.item-purpose').value = s.purpose || '';
      if (s.vendor_name) card.querySelector('.item-vendor').value = s.vendor_name;
      area.innerHTML = '<div class="item-suggest-label">候補を反映しました。内容を確認してください。</div>';
    });
  } catch (e) { /* 候補が引けなくても致命的ではないため無視 */ }
}

async function runOcrForItem(card, file) {
  const ocrStatus = card.querySelector('.ocr-status');
  ocrStatus.textContent = 'AIが内容を読み取っています...';
  try {
    const base64 = await fileToBase64(file);
    const session = getSession();
    const res = await fetch(`${N8N_BASE_URL}/webhook/receipt-ocr-proxy`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeCode: session.employeeCode, mimeType: file.type || 'image/jpeg', base64 }),
    });
    const json = await res.json().catch(() => null);
    const receipt = json && json.receipts && json.receipts[0];
    if (!receipt) { ocrStatus.textContent = ''; return; }

    // 読み取れた事実だけをフォームへ候補入力する(現場・使用目的・取引先はプロンプト側で
    // 出力させていないため、ここで埋まることはない=AIが推測で確定しない設計)。
    if (receipt.document_date) card.querySelector('.item-date').value = receipt.document_date;
    if (receipt.counterparty_raw) card.querySelector('.item-store').value = receipt.counterparty_raw;
    if (receipt.total_amount != null) { card.querySelector('.item-amount').value = receipt.total_amount; updateExpenseTotal(); }
    if (receipt.tax_amount != null) card.querySelector('.item-tax').value = receipt.tax_amount;

    const confidence = receipt.confidence || 'low';
    if (confidence === 'high') {
      ocrStatus.textContent = 'AIが内容を読み取りました。内容を確認してください(間違っていれば修正できます)。';
    } else if (confidence === 'medium') {
      ocrStatus.textContent = '読み取り精度が高くありません。内容を必ず確認・修正してください。';
    } else {
      ocrStatus.textContent = '読み取りに自信が持てませんでした。手入力で確認してください。';
      // 低信頼は候補として埋めない方が安全なため、金額以外はクリアする
      card.querySelector('.item-date').value = '';
      card.querySelector('.item-store').value = '';
    }

    if (receipt.counterparty_raw && confidence !== 'low') showExpenseSuggestion(card, receipt.counterparty_raw);
  } catch (e) {
    ocrStatus.textContent = '';
  }
}

function addExpenseItem(initialFile) {
  const template = document.getElementById('expense-item-template');
  const clone = template.content.cloneNode(true);
  hydrateIcons(clone);
  const itemId = `item-${++expenseItemSeq}`;
  const card = clone.querySelector('.expense-item-card');
  card.dataset.itemId = itemId;
  clone.querySelector('.item-label').textContent = `明細${expenseItemSeq}`;
  expenseItemState.set(itemId, { driveFileId: null, driveFileUrl: null, uploading: false });

  const paymentSelect = clone.querySelector('.item-payment');
  paymentSelect.innerHTML = EXPENSE_PAYMENT_OPTIONS[currentExpenseCategory].map((p) => `<option value="${p}">${p}</option>`).join('');

  const siteSelect = clone.querySelector('.item-site-select');
  const siteSearch = clone.querySelector('.item-site-search');
  populateSiteSelect(siteSelect, '');
  siteSearch.addEventListener('input', () => populateSiteSelect(siteSelect, siteSearch.value.trim()));

  clone.querySelector('.remove-item-btn').addEventListener('click', () => {
    document.querySelector(`[data-item-id="${itemId}"]`).remove();
    expenseItemState.delete(itemId);
    updateExpenseTotal();
  });

  const preview = clone.querySelector('.item-photo-preview');
  const status = clone.querySelector('.photo-status');
  const photoStep = clone.querySelector('.item-photo-step');
  const photoAttached = clone.querySelector('.item-photo-attached');
  const details = clone.querySelector('.item-details');

  async function handlePhotoFile(file) {
    if (!file) return;
    photoStep.style.display = 'none';
    photoAttached.style.display = 'block';
    details.style.display = 'block';
    preview.src = URL.createObjectURL(file);
    status.textContent = 'アップロード中...';
    status.className = 'photo-status uploading';
    const state = expenseItemState.get(itemId);
    state.uploading = true;
    const cardEl = document.querySelector(`[data-item-id="${itemId}"]`);
    runOcrForItem(cardEl, file); // 並行実行(アップロード完了を待たずにOCRも進める)
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
  }

  clone.querySelector('.item-photo-input').addEventListener('change', (e) => handlePhotoFile(e.target.files[0]));
  clone.querySelector('.item-photo-input-lib').addEventListener('change', (e) => handlePhotoFile(e.target.files[0]));
  clone.querySelector('.retake-btn').addEventListener('click', () => {
    photoStep.style.display = 'flex';
    photoStep.style.flexDirection = 'column';
    photoAttached.style.display = 'none';
    status.textContent = '';
    const cardEl = document.querySelector(`[data-item-id="${itemId}"]`);
    cardEl.querySelector('.ocr-status').textContent = '';
    const state = expenseItemState.get(itemId);
    state.driveFileId = null;
    state.driveFileUrl = null;
  });

  clone.querySelector('.item-amount').addEventListener('input', updateExpenseTotal);
  clone.querySelector('.item-store').addEventListener('blur', (e) => {
    const cardEl = document.querySelector(`[data-item-id="${itemId}"]`);
    if (e.target.value.trim()) showExpenseSuggestion(cardEl, e.target.value.trim());
  });

  document.getElementById('expense-item-list').appendChild(clone);
  updateExpenseTotal();
  if (initialFile) handlePhotoFile(initialFile);
}

// 複数の領収書写真を一度に選択したとき、写真1枚ごとに明細を1件自動作成してOCRを走らせる
// (写真1→OCR→明細1、写真2→OCR→明細2、…という流れ。1枚ずつ手作業で追加する必要をなくす)。
function addExpenseItemsBatch(files) {
  Array.from(files || []).forEach((file) => addExpenseItem(file));
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
    const tax = card.querySelector('.item-tax').value;
    const siteSelect = card.querySelector('.item-site-select');
    const siteId = siteSelect.value || null;
    const siteName = siteId ? siteSelect.options[siteSelect.selectedIndex].dataset.name : null;
    const vendor = card.querySelector('.item-vendor').value.trim();
    const purpose = card.querySelector('.item-purpose').value.trim();
    const payment = card.querySelector('.item-payment').value;
    const note = card.querySelector('.item-note').value.trim();
    const label = card.querySelector('.item-label').textContent;

    if (state.uploading) { showError('expense-error', `${label}: 写真のアップロード中です。少しお待ちください。`); return; }
    if (!state.driveFileId) { showError('expense-error', `${label}: 領収書またはレシートの写真を添付してください。`); return; }
    if (!date || !store || !amount) { showError('expense-error', `${label}: 利用日・支払先・金額は必須です。`); return; }
    if (!purpose) { showError('expense-error', `${label}: 使用目的を入力してください。`); return; }
    if (!siteId) { showError('expense-error', `${label}: 現場を選択してください。`); return; }

    items.push({
      document_date: date, store, amount, tax_amount: tax ? Number(tax) : null,
      site_id: siteId, site_name: siteName, vendor_name: vendor || null, purpose,
      payment_method: payment, content_description: note || null,
      drive_file_id: state.driveFileId, drive_file_url: state.driveFileUrl,
    });
  }

  const btn = document.getElementById('expense-submit');
  btn.disabled = true;
  try {
    const result = await rpc('submit_expense_claim', { p_employee_code: session.employeeCode, p_expense_category: currentExpenseCategory, p_items: items });
    const r = result && result[0];
    const label = currentExpenseCategory === 'company_expense' ? '会社経費登録' : '経費立替申請';
    document.getElementById('done-message').textContent = `${label}を受け付けました(${r ? r.item_count : items.length}件、合計${r ? Number(r.total_amount).toLocaleString() : ''}円)。承認をお待ちください。`;
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

const REQUEST_TYPE_LABEL = { paid_leave: '有給休暇申請', expense_reimbursement: '経費立替申請', meeting: '会議申請', supply_item: '支給品申請', other: 'その他' };
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

// ---------- 支給品申請(社員): 選択式。一覧にタップで選び、「その他」だけ自由入力欄を出す ----------

const SUPPLY_ICON_BY_NAME = {
  '制服ジャケット': 'briefcase', '制服ズボン': 'briefcase', 'ヘルメット': 'shield', '安全帯': 'shield',
  'フルハーネス': 'shield', '安全靴': 'package', '手袋': 'package', '空調服': 'package', '空調服バッテリー': 'package',
};

let selectedSupplyMasterId = null;
let selectedSupplyMasterItem = null;

async function loadSupplySelectGrid() {
  const grid = document.getElementById('supply-select-grid');
  grid.innerHTML = '<div class="hint">読み込み中...</div>';
  document.getElementById('supply-req-detail').style.display = 'none';
  selectedSupplyMasterId = null;
  selectedSupplyMasterItem = null;
  try {
    const rows = await rpc('list_supply_master', {});
    const cards = rows.map((m) => ({ id: m.id, name: m.item_name, requiresSize: m.requires_size, icon: SUPPLY_ICON_BY_NAME[m.item_name] || 'package' }));
    cards.push({ id: 'other', name: 'その他', requiresSize: false, icon: 'plus' });
    grid.innerHTML = cards.map((c) => `
      <button type="button" class="supply-select-card" data-id="${c.id}" data-name="${c.name}" data-requires-size="${c.requiresSize}">
        ${icon(c.icon)}
        <span class="supply-select-card-label">${c.name}</span>
      </button>
    `).join('');
    grid.querySelectorAll('.supply-select-card').forEach((el) => {
      el.addEventListener('click', () => selectSupplyMasterCard(el));
    });
  } catch (e) {
    grid.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

function selectSupplyMasterCard(el) {
  document.querySelectorAll('.supply-select-card').forEach((c) => c.classList.remove('selected'));
  el.classList.add('selected');
  const isOther = el.dataset.id === 'other';
  selectedSupplyMasterId = isOther ? null : Number(el.dataset.id);
  selectedSupplyMasterItem = el.dataset.name;

  document.getElementById('supply-req-detail').style.display = 'block';
  document.getElementById('supply-req-selected-title').textContent = isOther ? 'その他の支給品' : el.dataset.name;
  document.getElementById('supply-req-other-wrap').style.display = isOther ? 'block' : 'none';
  document.getElementById('supply-req-size-wrap').style.display = (el.dataset.requiresSize === 'true') ? 'block' : 'none';
  document.getElementById('supply-req-master-id').value = selectedSupplyMasterId || '';
}

async function doSubmitSupplyRequest() {
  const session = getSession();
  const isOther = selectedSupplyMasterId == null;
  const otherName = document.getElementById('supply-req-other-name').value.trim();
  const qty = document.getElementById('supply-req-qty').value;
  const size = document.getElementById('supply-req-size').value.trim();
  const kind = document.getElementById('supply-req-kind').value;
  const reasonInput = document.getElementById('supply-req-reason').value.trim();
  const reason = [kind, reasonInput].filter(Boolean).join(' / ');
  hideError('supply-req-error');

  if (!selectedSupplyMasterItem) { showError('supply-req-error', '支給品を選択してください。'); return; }
  if (isOther && !otherName) { showError('supply-req-error', '上記以外の支給品名を入力してください。'); return; }
  if (!reasonInput) { showError('supply-req-error', '申請理由を入力してください。'); return; }

  const btn = document.getElementById('supply-req-submit');
  btn.disabled = true;
  try {
    await rpc('submit_supply_request', {
      p_employee_code: session.employeeCode,
      p_item_name: isOther ? otherName : null,
      p_quantity: qty ? Number(qty) : 1,
      p_size: size || null,
      p_reason: reason,
      p_master_item_id: selectedSupplyMasterId,
    });
    document.getElementById('done-message').textContent = '支給品申請を受け付けました。承認をお待ちください。';
    showScreen('done');
  } catch (e) {
    showError('supply-req-error', e.message || '送信に失敗しました。もう一度お試しください。');
  } finally {
    btn.disabled = false;
  }
}

function formatElapsed(days) {
  if (days == null) return '';
  if (days < 30) return `${days}日`;
  if (days < 365) return `${Math.floor(days / 30)}ヶ月`;
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  return months > 0 ? `${years}年${months}ヶ月` : `${years}年`;
}

async function loadMySupply() {
  const session = getSession();
  const listEl = document.getElementById('my-supply-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_supply_history', { p_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) {
      listEl.innerHTML = '<div class="hint">まだ支給履歴がありません。</div>';
      return;
    }
    listEl.innerHTML = '';
    rows.forEach((r) => {
      const div = document.createElement('div');
      div.className = 'supply-item';
      div.innerHTML = `
        <div class="row1"><span>${r.item_name}</span><span>${r.quantity}個${r.size ? '(' + r.size + ')' : ''}</span></div>
        <div class="row2">支給日: ${r.issued_date}${r.condition === 'new' ? '・新品' : r.condition === 'used' ? '・中古' : ''}</div>
        <div class="elapsed">経過: ${formatElapsed(r.elapsed_days)}${r.needs_return ? (r.returned_date ? `・返却済(${r.returned_date})` : '・返却必要') : ''}</div>
      `;
      listEl.appendChild(div);
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// ---------- 管理者画面 ----------

function isAdmin() {
  const session = getSession();
  return session && session.requestRole === 'executive';
}

async function loadAdminEmployeeSelects() {
  const session = getSession();
  const rows = await rpc('list_active_employees', { p_admin_employee_code: session.employeeCode });
  const options = rows.map((e) => `<option value="${e.employee_code}">${e.employee_code} ${e.employee_name}</option>`).join('');
  document.getElementById('admin-employee-select').innerHTML = options;
  document.getElementById('admin-issue-employee').innerHTML = options;
  await loadAdminIssueMasterSelect();
}

async function loadAdminIssueMasterSelect() {
  const session = getSession();
  const select = document.getElementById('admin-issue-master');
  try {
    const rows = await rpc('admin_list_supply_master', { p_admin_employee_code: session.employeeCode });
    const active = rows.filter((m) => m.active);
    select.innerHTML = active.map((m) => `<option value="${m.id}" data-requires-size="${m.requires_size}">${m.item_name}</option>`).join('') + '<option value="">その他(自由入力)</option>';
    toggleAdminIssueOtherWrap();
  } catch (e) { /* 読み込めなくても記録フォーム自体は使える(その他扱いになる) */ }
}

function toggleAdminIssueOtherWrap() {
  const select = document.getElementById('admin-issue-master');
  const isOther = !select.value;
  document.getElementById('admin-issue-other-wrap').style.display = isOther ? 'block' : 'none';
}

async function loadAdminEmployeeDetail() {
  const session = getSession();
  const targetCode = document.getElementById('admin-employee-select').value;
  const detailEl = document.getElementById('admin-employee-detail');
  if (!targetCode) return;
  detailEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_employee_admin_summary', { p_admin_employee_code: session.employeeCode, p_target_employee_code: targetCode });
    const s = rows && rows[0];
    if (!s) { detailEl.innerHTML = ''; return; }
    const supplyLines = (s.supply_history || []).slice(0, 10).map((h) => `<div class="row2">${h.issued_date} ${h.item_name} ${h.quantity}個</div>`).join('');
    detailEl.innerHTML = `
      <div class="summary-row"><span>有給残日数</span><span class="summary-value">${s.leave_balance != null ? s.leave_balance + '日' : '未登録'}</span></div>
      <div class="summary-row"><span>今年使用</span><span class="summary-value">${s.leave_used_this_year}日(${s.leave_taken_count_this_year}回)</span></div>
      <div class="section-title" style="margin:14px 0 6px;">支給品履歴</div>
      ${supplyLines || '<div class="hint">支給履歴なし</div>'}
    `;
  } catch (e) {
    detailEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doAdminResetPin() {
  const session = getSession();
  const targetCode = document.getElementById('admin-employee-select').value;
  const statusEl = document.getElementById('admin-reset-pin-status');
  if (!targetCode) return;
  statusEl.textContent = '';
  try {
    await rpc('admin_reset_employee_pin', { p_admin_employee_code: session.employeeCode, p_target_employee_code: targetCode });
    statusEl.textContent = 'リセットしました。対象の社員は次回ログイン時に新しい暗証番号を設定できます。';
    statusEl.style.color = 'var(--success)';
  } catch (e) {
    statusEl.textContent = 'リセットに失敗しました: ' + e.message;
    statusEl.style.color = 'var(--danger)';
  }
}

async function doAdminRecordIssuance() {
  const session = getSession();
  const targetCode = document.getElementById('admin-issue-employee').value;
  const date = document.getElementById('admin-issue-date').value;
  const masterSelect = document.getElementById('admin-issue-master');
  const masterId = masterSelect.value ? Number(masterSelect.value) : null;
  const otherItem = document.getElementById('admin-issue-item').value.trim();
  const qty = document.getElementById('admin-issue-qty').value;
  const size = document.getElementById('admin-issue-size').value.trim();
  const condition = document.getElementById('admin-issue-condition').value;
  const reason = document.getElementById('admin-issue-reason').value.trim();
  const needsReturn = document.getElementById('admin-issue-return').checked;
  const note = document.getElementById('admin-issue-note').value.trim();
  hideError('admin-issue-error');

  if (!targetCode || !date || (!masterId && !otherItem)) {
    showError('admin-issue-error', '対象社員・支給日・支給品は必須です。');
    return;
  }

  const btn = document.getElementById('admin-issue-submit');
  btn.disabled = true;
  try {
    await rpc('record_supply_issuance', {
      p_admin_employee_code: session.employeeCode, p_target_employee_code: targetCode, p_issued_date: date,
      p_item_name: masterId ? null : otherItem, p_quantity: qty ? Number(qty) : 1, p_size: size || null, p_condition: condition,
      p_reason: reason || null, p_needs_return: needsReturn, p_note: note || null, p_master_item_id: masterId,
    });
    ['admin-issue-date', 'admin-issue-item', 'admin-issue-size', 'admin-issue-reason', 'admin-issue-note'].forEach((id) => { document.getElementById(id).value = ''; });
    document.getElementById('admin-issue-qty').value = '1';
    document.getElementById('admin-issue-return').checked = false;
    if (document.getElementById('admin-employee-select').value === targetCode) loadAdminEmployeeDetail();
    showError('admin-issue-error', '記録しました。');
    document.getElementById('admin-issue-error').style.color = 'var(--success)';
  } catch (e) {
    document.getElementById('admin-issue-error').style.color = '';
    showError('admin-issue-error', '記録に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

async function doAdminSearch() {
  const session = getSession();
  const itemName = document.getElementById('admin-search-item').value.trim();
  const unreturnedOnly = document.getElementById('admin-search-unreturned').checked;
  const resultsEl = document.getElementById('admin-search-results');
  resultsEl.innerHTML = '<div class="hint">検索中...</div>';
  try {
    const rows = await rpc('get_supply_admin_list', {
      p_admin_employee_code: session.employeeCode, p_item_name: itemName || null, p_unreturned_only: unreturnedOnly,
    });
    if (!rows || rows.length === 0) { resultsEl.innerHTML = '<div class="hint">該当なし</div>'; return; }
    resultsEl.innerHTML = '';
    rows.forEach((r) => {
      const div = document.createElement('div');
      div.className = 'admin-result-item';
      div.innerHTML = `
        <div class="row1"><span>${r.employee_name}(${r.employee_code})</span><span>${r.item_name} ${r.quantity}個</span></div>
        <div class="row2">支給日: ${r.issued_date}・経過${formatElapsed(r.elapsed_days)}${r.needs_return ? (r.returned_date ? `・返却済(${r.returned_date})` : '・未返却') : ''}</div>
        ${r.needs_return && !r.returned_date ? `<button type="button" class="return-btn" data-issuance-id="${r.id}">返却済みにする</button>` : ''}
      `;
      resultsEl.appendChild(div);
    });
    resultsEl.querySelectorAll('.return-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await rpc('mark_supply_returned', { p_admin_employee_code: session.employeeCode, p_issuance_id: Number(btn.dataset.issuanceId), p_returned_date: new Date().toISOString().slice(0, 10) });
        doAdminSearch();
      });
    });
  } catch (e) {
    resultsEl.innerHTML = '<div class="hint">検索に失敗しました。</div>';
  }
}

// ---------- 匿名相談ボックス ----------
// 通常の申請(社員番号と紐付く)とは完全に別のデータ・別のローカルストレージキーで扱う。
// ここにemployeeCode等を混ぜない(混ぜた瞬間に匿名性が崩れるため)。

const ANON_STORAGE_KEY = 'jinshou_anon_consultations'; // [{code, token, category, createdAt}]
let currentAnonCode = null;
let currentAnonToken = null;
let currentAnonAdminCode = null;
let currentAdminRequestFilter = null;

function getAnonConsultations() {
  try { return JSON.parse(localStorage.getItem(ANON_STORAGE_KEY)) || []; } catch { return []; }
}
function saveAnonConsultation(entry) {
  const list = getAnonConsultations();
  list.unshift(entry);
  localStorage.setItem(ANON_STORAGE_KEY, JSON.stringify(list));
}

const URGENCY_LABEL = { normal: '通常', soon: '早めに対応希望', urgent: '緊急' };
const ANON_STATUS_LABEL = { unconfirmed: '未確認', confirmed: '確認済み', in_progress: '対応中', resolved: '対応完了' };

async function doSubmitAnonConsultation() {
  const category = document.getElementById('anon-category').value;
  const content = document.getElementById('anon-content').value.trim();
  const urgency = document.querySelector('input[name="anon-urgency"]:checked').value;
  hideError('anon-submit-error');

  if (!content) {
    showError('anon-submit-error', '相談内容を入力してください。');
    return;
  }

  const btn = document.getElementById('anon-submit-btn');
  btn.disabled = true;
  try {
    const rows = await rpc('submit_anonymous_consultation', { p_category: category, p_content: content, p_urgency: urgency });
    const r = rows[0];
    saveAnonConsultation({ code: r.consultation_code, token: r.anon_token, category, createdAt: new Date().toISOString() });
    document.getElementById('anon-content').value = '';
    document.getElementById('anon-done-code').textContent = r.consultation_code;
    showScreen('anon-done');
  } catch (e) {
    showError('anon-submit-error', '送信に失敗しました。もう一度お試しください。');
  } finally {
    btn.disabled = false;
  }
}

async function loadMyAnonConsultations() {
  const listEl = document.getElementById('anon-my-list');
  const list = getAnonConsultations();
  if (list.length === 0) { listEl.innerHTML = '<div class="hint">まだ相談を送っていません。</div>'; return; }
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';

  const rendered = [];
  for (const entry of list) {
    try {
      const rows = await rpc('get_anonymous_consultation_thread', { p_consultation_code: entry.code, p_anon_token: entry.token });
      const status = rows[0] ? rows[0].status : 'unconfirmed';
      const last = rows[rows.length - 1];
      rendered.push(`
        <div class="consult-list-item" data-code="${entry.code}">
          <div class="row1"><span>${entry.category}</span><span class="status-badge ${status === 'resolved' ? 'done' : ''}">${ANON_STATUS_LABEL[status]}</span></div>
          <div class="row2">相談番号: ${entry.code}${last ? ' ・最新: ' + (last.sender === 'admin' ? '会社からの返信あり' : '自分の送信') : ''}</div>
        </div>
      `);
    } catch (e) {
      rendered.push(`<div class="consult-list-item"><div class="row1">相談番号: ${entry.code}</div><div class="row2">読み込みに失敗しました</div></div>`);
    }
  }
  listEl.innerHTML = rendered.join('');
  listEl.querySelectorAll('.consult-list-item').forEach((el) => {
    el.addEventListener('click', () => openAnonThread(el.dataset.code));
  });
}

async function openAnonThread(code) {
  const entry = getAnonConsultations().find((c) => c.code === code);
  if (!entry) return;
  currentAnonCode = entry.code;
  currentAnonToken = entry.token;
  document.getElementById('anon-thread-code').textContent = code;
  showScreen('anon-thread');
  await renderAnonThread();
}

async function renderAnonThread() {
  const messagesEl = document.getElementById('anon-thread-messages');
  messagesEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_anonymous_consultation_thread', { p_consultation_code: currentAnonCode, p_anon_token: currentAnonToken });
    messagesEl.innerHTML = rows.map((m) => `
      <div class="chat-bubble from-${m.sender}">
        ${m.message}
        <div class="meta">${m.sender === 'admin' ? '会社' : '自分'} ・ ${new Date(m.sent_at).toLocaleString('ja-JP')}</div>
      </div>
    `).join('') || '<div class="hint">メッセージがありません。</div>';
  } catch (e) {
    messagesEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doSendAnonThreadMessage() {
  const message = document.getElementById('anon-thread-reply').value.trim();
  hideError('anon-thread-error');
  if (!message) return;
  const btn = document.getElementById('anon-thread-send');
  btn.disabled = true;
  try {
    await rpc('send_anonymous_employee_message', { p_consultation_code: currentAnonCode, p_anon_token: currentAnonToken, p_message: message });
    document.getElementById('anon-thread-reply').value = '';
    await renderAnonThread();
  } catch (e) {
    showError('anon-thread-error', '送信に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

async function checkAnonUnreadBadge() {
  const list = getAnonConsultations();
  const badge = document.getElementById('home-anon-badge');
  for (const entry of list) {
    try {
      const unread = await rpc('has_unread_anonymous_reply', { p_consultation_code: entry.code, p_anon_token: entry.token });
      if (unread) { badge.style.display = 'block'; return; }
    } catch (e) { /* 個別の失敗は無視して他をチェックし続ける */ }
  }
  badge.style.display = 'none';
}

// ---------- 匿名相談管理(管理者) ----------

async function loadAnonAdminList() {
  const session = getSession();
  const status = document.getElementById('anon-admin-status-filter').value || null;
  const listEl = document.getElementById('anon-admin-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('list_anonymous_consultations_admin', { p_admin_employee_code: session.employeeCode, p_status: status });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">該当する相談はありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => `
      <div class="consult-list-item" data-code="${r.consultation_code}">
        <div class="row1">
          <span><span class="urgency-tag ${r.urgency}">${r.urgency === 'urgent' ? '🔴 緊急' : URGENCY_LABEL[r.urgency]}</span> ${r.category}${r.has_unread_employee_message ? ' 🔵' : ''}</span>
        </div>
        <div class="row2">${r.content.length > 60 ? r.content.slice(0, 60) + '…' : r.content}</div>
        <div class="row2">#${r.consultation_code} ・ ${new Date(r.created_at).toLocaleString('ja-JP')}</div>
        <span class="status-badge ${r.status === 'resolved' ? 'done' : ''}">${ANON_STATUS_LABEL[r.status]}</span>
      </div>
    `).join('');
    listEl.querySelectorAll('.consult-list-item').forEach((el) => {
      el.addEventListener('click', () => openAnonAdminThread(el.dataset.code));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function openAnonAdminThread(code) {
  currentAnonAdminCode = code;
  document.getElementById('anon-admin-thread-code').textContent = code;
  showScreen('anon-admin-thread');
  await renderAnonAdminThread();
}

async function renderAnonAdminThread() {
  const session = getSession();
  const messagesEl = document.getElementById('anon-admin-thread-messages');
  messagesEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_anonymous_consultation_admin_thread', { p_admin_employee_code: session.employeeCode, p_consultation_code: currentAnonAdminCode });
    if (rows[0]) document.getElementById('anon-admin-status-select').value = rows[0].status;
    messagesEl.innerHTML = rows.map((m) => `
      <div class="chat-bubble from-${m.sender === 'admin' ? 'employee' : 'admin'}">
        ${m.message}
        <div class="meta">${m.sender === 'admin' ? '会社(自分)' : '社員'} ・ ${new Date(m.sent_at).toLocaleString('ja-JP')}</div>
      </div>
    `).join('') || '<div class="hint">メッセージがありません。</div>';
  } catch (e) {
    messagesEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doAdminReplyAnon() {
  const session = getSession();
  const message = document.getElementById('anon-admin-reply').value.trim();
  hideError('anon-admin-thread-error');
  if (!message) return;
  const btn = document.getElementById('anon-admin-reply-btn');
  btn.disabled = true;
  try {
    await rpc('admin_reply_anonymous_consultation', { p_admin_employee_code: session.employeeCode, p_consultation_code: currentAnonAdminCode, p_message: message });
    document.getElementById('anon-admin-reply').value = '';
    await renderAnonAdminThread();
  } catch (e) {
    showError('anon-admin-thread-error', '送信に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

async function doAdminChangeAnonStatus() {
  const session = getSession();
  const status = document.getElementById('anon-admin-status-select').value;
  try {
    await rpc('admin_update_anonymous_consultation_status', { p_admin_employee_code: session.employeeCode, p_consultation_code: currentAnonAdminCode, p_status: status });
  } catch (e) { /* 失敗時は選択が反映されないだけなので致命的ではない */ }
}

// ---------- 今日やること・お知らせ(社員側) ----------

async function loadTodayList() {
  const session = getSession();
  const listEl = document.getElementById('today-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_dashboard', { p_employee_code: session.employeeCode });
    const d = rows && rows[0];
    const items = [];
    if (d) {
      if (d.unread_announcements > 0) items.push({ icon: 'bell', label: '未読のお知らせがあります', count: `${d.unread_announcements}件`, nav: 'announcements' });
      if (d.needs_info_count > 0) items.push({ icon: 'edit', label: '確認・修正が必要な申請があります', count: `${d.needs_info_count}件`, nav: 'history', urgent: true });
      if (d.waiting_approval_count > 0) items.push({ icon: 'clock', label: '承認待ちの申請があります', count: `${d.waiting_approval_count}件`, nav: 'history' });
      if (d.qualification_expiring_count > 0) items.push({ icon: 'graduation-cap', label: '期限が近い資格があります', count: `${d.qualification_expiring_count}件`, nav: 'my-qual', urgent: true });
    }
    const anonBadgeEl = document.getElementById('home-anon-badge');
    const anonUnread = anonBadgeEl && anonBadgeEl.style.display !== 'none';
    if (anonUnread) {
      items.push({ icon: 'message-circle', label: '匿名相談に会社から返信があります', count: '', nav: 'anon-consult' });
    }
    if (items.length === 0) {
      listEl.innerHTML = '<div class="today-empty">今日確認が必要なことはありません。</div>';
      return;
    }
    listEl.innerHTML = items.map((it, i) => `
      <button type="button" class="today-item ${it.urgent ? 'urgent' : ''}" data-idx="${i}">
        <span class="today-item-icon">${icon(it.icon)}</span>
        <span class="today-item-body"><span class="today-item-label">${it.label}</span><span class="today-item-count">${it.count}</span></span>
        <span class="today-item-arrow">${icon('chevron-right')}</span>
      </button>
    `).join('');
    listEl.querySelectorAll('.today-item').forEach((el) => {
      el.addEventListener('click', () => showScreen(items[Number(el.dataset.idx)].nav));
    });
  } catch (e) {
    listEl.innerHTML = '';
  }
}

async function loadAnnounceBanner() {
  const session = getSession();
  const area = document.getElementById('announce-banner-area');
  area.innerHTML = '';
  try {
    const rows = await rpc('get_my_announcements', { p_employee_code: session.employeeCode });
    const important = (rows || []).find((a) => a.importance === 'important' && !a.is_read);
    if (!important) return;
    area.innerHTML = `
      <button type="button" class="announce-banner" id="home-announce-banner">
        <div class="announce-banner-label">📢 重要なお知らせ</div>
        <div class="announce-banner-title">${important.title}</div>
      </button>
    `;
    document.getElementById('home-announce-banner').addEventListener('click', () => showScreen('announcements'));
  } catch (e) { /* 表示できなくても致命的ではないため無視 */ }
}

async function loadAnnouncements() {
  const session = getSession();
  const listEl = document.getElementById('announcements-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_announcements', { p_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">お知らせはありません。</div>'; return; }
    listEl.innerHTML = rows.map((a) => `
      <div class="announce-item ${a.is_read ? '' : 'unread'}" data-id="${a.id}">
        <div class="row1">
          <span class="title">${a.importance === 'important' ? '📢 ' : ''}${a.title}</span>
          <span class="date">${new Date(a.created_at).toLocaleDateString('ja-JP')}</span>
        </div>
        <div class="body">${a.body}</div>
      </div>
    `).join('');
    listEl.querySelectorAll('.announce-item').forEach((el) => {
      el.addEventListener('click', async () => {
        const wasUnread = el.classList.contains('unread');
        el.classList.toggle('expanded');
        if (wasUnread) {
          el.classList.remove('unread');
          try { await rpc('mark_announcement_read', { p_employee_code: session.employeeCode, p_announcement_id: Number(el.dataset.id) }); } catch (e) { /* 無視 */ }
        }
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// ---------- 管理者ダッシュボード ----------

const DASH_CARDS = [
  { key: 'pending_expense_approvals', filter: 'expense', label: '経費立替 承認待ち', icon: 'receipt' },
  { key: 'pending_leave_approvals', filter: 'leave', label: '有給申請 承認待ち', icon: 'calendar' },
  { key: 'pending_meeting_approvals', filter: 'meeting', label: '会議申請 承認待ち', icon: 'users-round' },
  { key: 'pending_supply_requests', filter: 'supply', label: '支給品申請 確認待ち', icon: 'package' },
  { key: 'needs_correction_count', filter: 'needs_correction', label: '確認・修正が必要な申請', icon: 'edit' },
  { key: 'unanswered_consultations', filter: null, label: '未対応の匿名相談', icon: 'message-circle', nav: 'anon-admin' },
  { key: 'pending_qualifications', filter: null, label: '資格の確認待ち', icon: 'graduation-cap', nav: 'qual-admin' },
  { key: 'qualification_expiring_count', filter: null, label: '期限が近い資格', icon: 'clock', nav: 'qual-admin' },
  { key: 'category_review_needed_count', filter: null, label: '勘定科目の確認待ち', icon: 'hash', nav: 'category-review' },
  { key: 'pending_info_change_requests', filter: null, label: '個人情報の変更申請', icon: 'user', nav: 'info-change-admin' },
];

async function loadAdminDashboard() {
  const session = getSession();
  const grid = document.getElementById('admin-dashboard-grid');
  grid.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_admin_dashboard', { p_admin_employee_code: session.employeeCode });
    const d = rows && rows[0];
    grid.innerHTML = DASH_CARDS.map((c) => {
      const count = d ? d[c.key] : 0;
      return `
        <button type="button" class="dash-card" data-filter="${c.filter || ''}" data-nav="${c.nav || ''}">
          <span class="dash-card-top">${icon(c.icon)}<span class="dash-card-count ${count === 0 ? 'zero' : 'alert'}">${count}</span></span>
          <span class="dash-card-label">${c.label}</span>
        </button>
      `;
    }).join('');
    grid.querySelectorAll('.dash-card').forEach((el) => {
      el.addEventListener('click', () => {
        const nav = el.dataset.nav;
        if (nav) { showScreen(nav); return; }
        openAdminRequestList(el.dataset.filter);
      });
    });
  } catch (e) {
    grid.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

function openAdminRequestList(filter) {
  currentAdminRequestFilter = filter;
  const found = DASH_CARDS.find((c) => c.filter === filter);
  document.getElementById('admin-request-list-title').textContent = found ? found.label : '一覧';
  showScreen('admin-request-list');
}

async function loadAdminRequestList() {
  const session = getSession();
  const listEl = document.getElementById('admin-request-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  const canDecide = ['expense', 'leave', 'meeting'].includes(currentAdminRequestFilter);
  try {
    const rows = await rpc('list_pending_requests_admin', { p_admin_employee_code: session.employeeCode, p_filter: currentAdminRequestFilter });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">該当する申請はありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => {
      const amountStr = r.amount != null ? `${Number(r.amount).toLocaleString()}円` : '';
      return `
        <div class="history-item" data-id="${r.id}">
          <div class="row1"><span>${r.employee_name || ''}・${REQUEST_TYPE_LABEL[r.request_type] || r.request_type}</span><span>${amountStr}</span></div>
          <div class="row2">${new Date(r.requested_at).toLocaleDateString('ja-JP')}　${r.summary || ''}</div>
          <span class="status-badge">${STATUS_LABEL[r.status] || r.status}</span>
          ${canDecide ? `
            <div class="qual-verify-btns">
              <button type="button" class="approve-btn">承認する</button>
              <button type="button" class="reject-btn">差し戻す</button>
            </div>
            <div class="reject-reason-box" style="display:none;">
              <textarea class="reject-reason-input" placeholder="差戻し理由を入力してください"></textarea>
              <button type="button" class="reject-confirm-btn">差戻しを確定する</button>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
    listEl.querySelectorAll('.approve-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => doDecideRequest(e.target.closest('.history-item').dataset.id, 'approved'));
    });
    listEl.querySelectorAll('.reject-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.target.closest('.history-item').querySelector('.reject-reason-box').style.display = 'block';
      });
    });
    listEl.querySelectorAll('.reject-confirm-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const item = e.target.closest('.history-item');
        const reason = item.querySelector('.reject-reason-input').value.trim();
        if (!reason) return;
        doDecideRequest(item.dataset.id, 'rejected', reason);
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doDecideRequest(requestId, action, reason) {
  const session = getSession();
  try {
    await rpc('admin_decide_request', { p_admin_employee_code: session.employeeCode, p_request_id: Number(requestId), p_action: action, p_rejection_reason: reason || null });
    await loadAdminRequestList();
  } catch (e) {
    window.alert(e.message || '処理に失敗しました。');
  }
}

// ---------- お知らせ管理(管理者) ----------

async function loadAnnounceAdminEmployeeSelect() {
  const session = getSession();
  try {
    const rows = await rpc('list_active_employees', { p_admin_employee_code: session.employeeCode });
    document.getElementById('announce-employee-select').innerHTML = rows.map((e) => `<option value="${e.employee_code}">${e.employee_code} ${e.employee_name}</option>`).join('');
  } catch (e) { /* 無視 */ }
}

async function doCreateAnnouncement() {
  const session = getSession();
  const title = document.getElementById('announce-title').value.trim();
  const body = document.getElementById('announce-body').value.trim();
  const importance = document.querySelector('input[name="announce-importance"]:checked').value;
  const target = document.querySelector('input[name="announce-target"]:checked').value;
  hideError('announce-error');
  if (!title || !body) { showError('announce-error', 'タイトルと本文を入力してください。'); return; }
  let employeeCodes = null;
  if (target === 'select') {
    const select = document.getElementById('announce-employee-select');
    employeeCodes = Array.from(select.selectedOptions).map((o) => o.value);
    if (employeeCodes.length === 0) { showError('announce-error', '配信先の社員を選択してください。'); return; }
  }
  const btn = document.getElementById('announce-submit');
  btn.disabled = true;
  try {
    await rpc('admin_create_announcement', {
      p_admin_employee_code: session.employeeCode, p_title: title, p_body: body,
      p_importance: importance, p_employee_codes: employeeCodes,
    });
    document.getElementById('announce-title').value = '';
    document.getElementById('announce-body').value = '';
    document.getElementById('announce-importance-normal').checked = true;
    document.getElementById('announce-target-all').checked = true;
    document.getElementById('announce-employee-select').style.display = 'none';
    document.getElementById('announce-target-hint').style.display = 'none';
    await loadAnnounceAdminList();
  } catch (e) {
    showError('announce-error', e.message || '送信に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

async function loadAnnounceAdminList() {
  const session = getSession();
  const listEl = document.getElementById('announce-admin-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('list_announcements_admin', { p_admin_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">まだお知らせを送信していません。</div>'; return; }
    listEl.innerHTML = rows.map((a) => `
      <div class="announce-admin-item" data-id="${a.id}" data-title="${a.title.replace(/"/g, '&quot;')}">
        <div class="row1"><span>${a.importance === 'important' ? '📢 ' : ''}${a.title}</span><span>${a.read_count}/${a.recipient_count} 既読</span></div>
        <div class="row2">${new Date(a.created_at).toLocaleString('ja-JP')}</div>
      </div>
    `).join('');
    listEl.querySelectorAll('.announce-admin-item').forEach((el) => {
      el.addEventListener('click', () => openAnnounceStatus(Number(el.dataset.id), el.dataset.title));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function openAnnounceStatus(id, title) {
  const session = getSession();
  document.getElementById('announce-status-title').textContent = title;
  showScreen('announce-status');
  const listEl = document.getElementById('announce-status-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_announcement_read_status_admin', { p_admin_employee_code: session.employeeCode, p_announcement_id: id });
    listEl.innerHTML = rows.map((r) => `
      <div class="read-status-row">
        <span class="name">${r.employee_name}</span>
        <span class="read-at ${r.read_at ? '' : 'unread'}">${r.read_at ? new Date(r.read_at).toLocaleString('ja-JP') : '未読'}</span>
      </div>
    `).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// ---------- 資格 ----------

let qualPhotoUpload = null;
let qualPdfUpload = null;

async function handleQualFile(file, kind) {
  if (!file) return;
  const statusEl = document.getElementById(`qual-${kind}-status`);
  const labelEl = document.getElementById(`qual-${kind}-label`);
  statusEl.textContent = 'アップロード中...';
  try {
    const session = getSession();
    const result = await uploadReceiptPhoto(session.employeeCode, file);
    if (kind === 'photo') qualPhotoUpload = result; else qualPdfUpload = result;
    statusEl.textContent = 'アップロード完了';
    labelEl.textContent = file.name;
  } catch (e) {
    statusEl.textContent = 'アップロードに失敗しました。';
  }
}

function resetQualForm() {
  ['qual-name', 'qual-number', 'qual-obtained', 'qual-expiry', 'qual-renewal', 'qual-note'].forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('qual-photo-input').value = '';
  document.getElementById('qual-pdf-input').value = '';
  document.getElementById('qual-photo-label').textContent = '写真を選ぶ';
  document.getElementById('qual-pdf-label').textContent = 'PDFを選ぶ';
  document.getElementById('qual-photo-status').textContent = '';
  document.getElementById('qual-pdf-status').textContent = '';
  qualPhotoUpload = null;
  qualPdfUpload = null;
  hideError('qual-error');
}

async function doSubmitQualification() {
  const session = getSession();
  const name = document.getElementById('qual-name').value.trim();
  hideError('qual-error');
  if (!name) { showError('qual-error', '資格名を入力してください。'); return; }
  const btn = document.getElementById('qual-submit');
  btn.disabled = true;
  try {
    await rpc('submit_qualification', {
      p_employee_code: session.employeeCode,
      p_qualification_name: name,
      p_qualification_number: document.getElementById('qual-number').value.trim() || null,
      p_obtained_date: document.getElementById('qual-obtained').value || null,
      p_expiry_date: document.getElementById('qual-expiry').value || null,
      p_renewal_deadline: document.getElementById('qual-renewal').value || null,
      p_note: document.getElementById('qual-note').value.trim() || null,
      p_photo_drive_file_id: qualPhotoUpload ? qualPhotoUpload.driveFileId : null,
      p_photo_drive_file_url: qualPhotoUpload ? qualPhotoUpload.driveFileUrl : null,
      p_pdf_drive_file_id: qualPdfUpload ? qualPdfUpload.driveFileId : null,
      p_pdf_drive_file_url: qualPdfUpload ? qualPdfUpload.driveFileUrl : null,
    });
    resetQualForm();
    document.getElementById('done-message').textContent = '資格を登録しました。管理者の確認をお待ちください。';
    showScreen('done');
  } catch (e) {
    showError('qual-error', e.message || '送信に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

const QUAL_STATUS_LABEL = { pending_verification: '確認待ち', active: '有効', rejected: '却下', expired: '期限切れ' };

async function loadMyQualifications() {
  const session = getSession();
  const listEl = document.getElementById('my-qual-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_qualifications', { p_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">登録された資格はまだありません。</div>'; return; }
    listEl.innerHTML = rows.map((q) => {
      const expiring = q.status === 'active' && q.days_until_expiry != null && q.days_until_expiry >= 0 && q.days_until_expiry <= 60;
      const expired = q.status === 'active' && q.days_until_expiry != null && q.days_until_expiry < 0;
      const expiryText = q.expiry_date ? `有効期限: ${new Date(q.expiry_date).toLocaleDateString('ja-JP')}${expiring ? `(残り${q.days_until_expiry}日)` : ''}${expired ? '(期限切れ)' : ''}` : '';
      return `
        <div class="qual-item ${expiring ? 'expiring' : ''} ${expired ? 'expired' : ''}">
          <div class="row1"><span>${q.qualification_name}</span><span class="status-badge ${q.status === 'active' ? 'done' : (q.status === 'rejected' ? 'rejected' : '')}">${QUAL_STATUS_LABEL[q.status] || q.status}</span></div>
          <div class="row2">${expiryText}</div>
          <div class="row2">${q.qualification_number ? `番号: ${q.qualification_number}` : ''}</div>
          <div style="margin-top:8px;">
            ${q.certificate_photo_url ? `<a class="file-link" href="${q.certificate_photo_url}" target="_blank" rel="noopener">写真を見る</a>` : ''}
            ${q.certificate_pdf_url ? `<a class="file-link" href="${q.certificate_pdf_url}" target="_blank" rel="noopener">PDFを見る</a>` : ''}
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// ---------- 資格管理(管理者) ----------

async function loadQualAdminList() {
  const session = getSession();
  const filter = document.getElementById('qual-admin-filter').value || null;
  const listEl = document.getElementById('qual-admin-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_qualifications', { p_admin_employee_code: session.employeeCode, p_filter: filter });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">該当する資格はありません。</div>'; return; }
    listEl.innerHTML = rows.map((q) => {
      const expiring = q.status === 'active' && q.days_until_expiry != null && q.days_until_expiry <= 60;
      const expiryText = q.expiry_date ? `有効期限: ${new Date(q.expiry_date).toLocaleDateString('ja-JP')}${q.days_until_expiry != null ? `(残り${q.days_until_expiry}日)` : ''}` : '期限未登録';
      return `
        <div class="qual-item ${expiring ? 'expiring' : ''}" data-id="${q.id}">
          <div class="row1"><span>${q.employee_name}・${q.qualification_name}</span><span class="status-badge ${q.status === 'active' ? 'done' : (q.status === 'rejected' ? 'rejected' : '')}">${QUAL_STATUS_LABEL[q.status] || q.status}</span></div>
          <div class="row2">${expiryText}</div>
          <div class="row2">${q.qualification_number ? `番号: ${q.qualification_number}` : ''}</div>
          <div style="margin-top:8px;">
            ${q.certificate_photo_url ? `<a class="file-link" href="${q.certificate_photo_url}" target="_blank" rel="noopener">写真を見る</a>` : ''}
            ${q.certificate_pdf_url ? `<a class="file-link" href="${q.certificate_pdf_url}" target="_blank" rel="noopener">PDFを見る</a>` : ''}
          </div>
          ${q.status === 'pending_verification' ? `
            <div class="qual-verify-btns">
              <button type="button" class="approve-btn">有効化する</button>
              <button type="button" class="reject-btn">却下する</button>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
    listEl.querySelectorAll('.approve-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => doVerifyQualification(e.target.closest('.qual-item').dataset.id, 'active'));
    });
    listEl.querySelectorAll('.reject-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => doVerifyQualification(e.target.closest('.qual-item').dataset.id, 'rejected'));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doVerifyQualification(id, action) {
  const session = getSession();
  try {
    await rpc('admin_verify_qualification', { p_admin_employee_code: session.employeeCode, p_qualification_id: Number(id), p_action: action });
    await loadQualAdminList();
  } catch (e) { /* 失敗時は一覧が更新されないだけ */ }
}

// ---------- 勘定科目確認(管理者) ----------

async function loadCategoryReview() {
  const session = getSession();
  const listEl = document.getElementById('category-review-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_category_review', { p_admin_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">確認が必要な勘定科目はありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => `
      <div class="category-review-item" data-document-id="${r.document_id}">
        <div class="row1"><span>${r.employee_name}・${r.store_name || ''}</span><span>${r.amount != null ? `${Number(r.amount).toLocaleString()}円` : ''}</span></div>
        <div class="row2">${r.document_date ? new Date(r.document_date).toLocaleDateString('ja-JP') : ''}　現場: ${r.site_name || '-'}　用途: ${r.purpose || '-'}</div>
        <div class="ai-suggest">AI提案: ${r.category_candidate || '(候補なし)'}${r.category_confidence ? `(確信度: ${r.category_confidence === 'medium' ? '中' : '低'})` : '(未提案)'}</div>
        <input type="text" class="category-input" list="category-suggest-list" placeholder="正しい勘定科目を入力" value="${r.category_candidate || ''}">
        <button type="button" class="confirm-btn">この科目で確定する</button>
      </div>
    `).join('');
    listEl.querySelectorAll('.category-review-item').forEach((el) => {
      el.querySelector('.confirm-btn').addEventListener('click', () => {
        const value = el.querySelector('.category-input').value.trim();
        if (!value) return;
        doConfirmCategory(el.dataset.documentId, value);
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doConfirmCategory(documentId, category) {
  const session = getSession();
  try {
    await rpc('admin_set_account_category', { p_admin_employee_code: session.employeeCode, p_document_id: Number(documentId), p_category: category, p_note: null });
    await loadCategoryReview();
  } catch (e) { /* 失敗時は一覧が更新されないだけ */ }
}

// ---------- 自分の情報(プロフィール) ----------

// 会社管理項目(社員番号・入社日等)は鍵アイコンつきで編集不可を明示。住所・電話番号等は
// 「変更申請」ボタンを付け、タップすると本人が変更申請を出せる(即時反映はしない)。
function fieldRow(label, value, editField) {
  const displayValue = value ? String(value) : '未登録';
  const editBtn = editField ? `<button type="button" class="field-edit-btn" data-edit-field="${editField}" data-current="${(value || '').replace(/"/g, '&quot;')}">変更申請</button>` : '';
  return `
    <div class="field-row">
      <span class="field-label">${label}</span>
      <span style="display:flex; align-items:center; gap:8px;">
        <span class="field-value ${value ? '' : 'empty'}">${displayValue}</span>
        ${editBtn}
      </span>
    </div>
  `;
}

function lockedFieldRow(label, value) {
  const displayValue = value ? String(value) : '未登録';
  return `
    <div class="field-row">
      <span class="field-label">${label}<span class="field-locked">${icon('lock')}管理者のみ変更可</span></span>
      <span class="field-value ${value ? '' : 'empty'}">${displayValue}</span>
    </div>
  `;
}

const CHANGE_FIELD_LABEL = {
  phone: '電話番号', postal_code: '郵便番号', address: '住所', email: 'メールアドレス',
  emergency_contact_name: '緊急連絡先(氏名)', emergency_contact_relation: '緊急連絡先(続柄)', emergency_contact_phone: '緊急連絡先(電話番号)',
};

async function loadMyInfo() {
  const session = getSession();
  document.getElementById('myinfo-avatar').textContent = (session.employeeName || '?').charAt(0);
  document.getElementById('myinfo-name').textContent = session.employeeName;
  document.getElementById('myinfo-code').textContent = `社員番号: ${session.employeeCode}`;
  loadHomeLeaveStats('myinfo-leave-balance', 'myinfo-leave-used');

  try {
    const rows = await rpc('get_my_profile', { p_employee_code: session.employeeCode });
    const p = rows && rows[0];
    if (!p) return;
    document.getElementById('myinfo-basic-fields').innerHTML =
      lockedFieldRow('社員番号', p.employee_code) +
      lockedFieldRow('氏名', p.employee_name) +
      lockedFieldRow('フリガナ', p.furigana) +
      lockedFieldRow('生年月日', p.birth_date ? new Date(p.birth_date).toLocaleDateString('ja-JP') : null) +
      lockedFieldRow('入社日', p.hire_date ? new Date(p.hire_date).toLocaleDateString('ja-JP') : null) +
      lockedFieldRow('所属/役割', p.department);
    document.getElementById('myinfo-contact-fields').innerHTML =
      fieldRow('メールアドレス', p.email, 'email') +
      fieldRow('電話番号', p.phone, 'phone') +
      fieldRow('郵便番号', p.postal_code, 'postal_code') +
      fieldRow('住所', p.address, 'address');
    document.getElementById('myinfo-emergency-fields').innerHTML =
      fieldRow('氏名', p.emergency_contact_name, 'emergency_contact_name') +
      fieldRow('続柄', p.emergency_contact_relation, 'emergency_contact_relation') +
      fieldRow('電話番号', p.emergency_contact_phone, 'emergency_contact_phone');

    document.querySelectorAll('.field-edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => openProfileEdit(btn.dataset.editField, btn.dataset.current));
    });
  } catch (e) { /* プロフィールが読めなくても他の情報は表示され続ける */ }
}

function openProfileEdit(field, currentValue) {
  document.getElementById('profile-edit-field').value = field;
  document.getElementById('profile-edit-title').textContent = `${CHANGE_FIELD_LABEL[field] || field}の変更申請`;
  document.getElementById('profile-edit-label').textContent = `新しい${CHANGE_FIELD_LABEL[field] || ''}`;
  const input = document.getElementById('profile-edit-value');
  input.value = currentValue || '';
  hideError('profile-edit-error');
  showScreen('profile-edit');
}

async function doSubmitProfileEdit() {
  const session = getSession();
  const field = document.getElementById('profile-edit-field').value;
  const value = document.getElementById('profile-edit-value').value.trim();
  hideError('profile-edit-error');
  if (!value) { showError('profile-edit-error', '内容を入力してください。'); return; }

  const btn = document.getElementById('profile-edit-submit');
  btn.disabled = true;
  try {
    await rpc('submit_info_change_request', { p_employee_code: session.employeeCode, p_field_name: field, p_new_value: value });
    document.getElementById('done-message').textContent = '変更を申請しました。管理者が確認したうえで反映されます。';
    showScreen('done');
  } catch (e) {
    showError('profile-edit-error', e.message || '送信に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

const CHANGE_STATUS_LABEL = { pending: '確認待ち', approved: '承認済み', rejected: '却下' };

async function loadMyChangeRequests() {
  const session = getSession();
  const listEl = document.getElementById('my-change-requests-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_change_requests', { p_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">変更申請はまだありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => `
      <div class="change-request-item">
        <div class="row1"><span>${CHANGE_FIELD_LABEL[r.field_name] || r.field_name}</span><span class="status-badge ${r.status === 'approved' ? 'done' : (r.status === 'rejected' ? 'rejected' : '')}">${CHANGE_STATUS_LABEL[r.status]}</span></div>
        <div class="row2">${r.old_value || '(未登録)'} → ${r.new_value}</div>
        <div class="row2">${new Date(r.created_at).toLocaleString('ja-JP')}${r.review_note ? `・${r.review_note}` : ''}</div>
      </div>
    `).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// ---------- 個人情報の変更申請確認(管理者) ----------

async function loadInfoChangeAdmin() {
  const session = getSession();
  const status = document.getElementById('info-change-filter').value || null;
  const listEl = document.getElementById('info-change-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_info_change_requests', { p_admin_employee_code: session.employeeCode, p_status: status });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">該当する変更申請はありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => `
      <div class="change-request-item" data-id="${r.id}">
        <div class="row1"><span>${r.employee_name}・${CHANGE_FIELD_LABEL[r.field_name] || r.field_name}</span><span class="status-badge ${r.status === 'approved' ? 'done' : (r.status === 'rejected' ? 'rejected' : '')}">${CHANGE_STATUS_LABEL[r.status]}</span></div>
        <div class="row2">${r.old_value || '(未登録)'} → ${r.new_value}</div>
        <div class="row2">${new Date(r.created_at).toLocaleString('ja-JP')}</div>
        ${r.status === 'pending' ? `
          <div class="qual-verify-btns">
            <button type="button" class="approve-btn">承認する</button>
            <button type="button" class="reject-btn">却下する</button>
          </div>
        ` : ''}
      </div>
    `).join('');
    listEl.querySelectorAll('.approve-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => doDecideInfoChange(e.target.closest('.change-request-item').dataset.id, 'approved'));
    });
    listEl.querySelectorAll('.reject-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => doDecideInfoChange(e.target.closest('.change-request-item').dataset.id, 'rejected'));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doDecideInfoChange(id, action) {
  const session = getSession();
  try {
    await rpc('admin_decide_info_change_request', { p_admin_employee_code: session.employeeCode, p_request_id: Number(id), p_action: action, p_note: null });
    await loadInfoChangeAdmin();
  } catch (e) { /* 失敗時は一覧が更新されないだけ */ }
}

// ---------- 社員名簿・社員管理(管理者) ----------

let employeeSearchTimer = null;
let employeeStatusFilter = 'active';
let currentEmployeeDetailCode = null;
let currentEmployeeDetailTab = 'basic';

async function loadEmployeeDirectory() {
  const session = getSession();
  const search = document.getElementById('employee-search-input').value.trim();
  const listEl = document.getElementById('employee-directory-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_employees', { p_admin_employee_code: session.employeeCode, p_search: search || null, p_status_filter: employeeStatusFilter || null, p_sort: 'code' });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">該当する社員はいません。</div>'; return; }
    listEl.innerHTML = rows.map((e) => `
      <div class="employee-row" data-code="${e.employee_code}">
        <div class="employee-avatar">${(e.employee_name || '?').charAt(0)}</div>
        <div class="employee-row-body">
          <div class="employee-row-name">${e.employee_name}<span style="color:var(--text-faint); font-weight:500; font-size:11.5px;">${e.employee_code}</span></div>
          <div class="employee-row-meta">${e.department || ''}${e.status !== 'active' ? '・在籍外' : ''}</div>
          <div class="employee-row-flags">
            ${e.qualification_warning_count > 0 ? `<span class="mini-tag warn">資格期限 ${e.qualification_warning_count}件</span>` : ''}
            ${e.pending_request_count > 0 ? `<span class="mini-tag info">未処理申請 ${e.pending_request_count}件</span>` : ''}
          </div>
        </div>
        <span style="color:var(--text-faint);">${icon('chevron-right')}</span>
      </div>
    `).join('');
    listEl.querySelectorAll('.employee-row').forEach((el) => {
      el.addEventListener('click', () => openEmployeeDetail(el.dataset.code));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function openEmployeeDetail(code) {
  currentEmployeeDetailCode = code;
  currentEmployeeDetailTab = 'basic';
  document.querySelectorAll('#employee-detail-tabs .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'basic'));
  document.querySelectorAll('#screen-employee-detail .tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'employee-detail-panel-basic'));
  showScreen('employee-detail');
  await loadEmployeeDetailBasic();
}

async function switchEmployeeDetailTab(tab) {
  currentEmployeeDetailTab = tab;
  document.querySelectorAll('#employee-detail-tabs .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('#screen-employee-detail .tab-panel').forEach((p) => p.classList.toggle('active', p.id === `employee-detail-panel-${tab}`));
  if (tab === 'basic') await loadEmployeeDetailBasic();
  else if (tab === 'leave') await loadEmployeeDetailLeave();
  else if (tab === 'qual') await loadEmployeeDetailQual();
  else if (tab === 'supply') await loadEmployeeDetailSupply();
  else if (tab === 'requests') await loadEmployeeDetailRequests();
}

async function loadEmployeeDetailBasic() {
  const session = getSession();
  const code = currentEmployeeDetailCode;
  try {
    const rows = await rpc('admin_get_employee_profile', { p_admin_employee_code: session.employeeCode, p_target_employee_code: code });
    const p = rows && rows[0];
    if (!p) return;
    document.getElementById('employee-detail-avatar').textContent = (p.employee_name || '?').charAt(0);
    document.getElementById('employee-detail-name').textContent = p.employee_name;
    document.getElementById('employee-detail-code').textContent = `社員番号: ${p.employee_code}・${p.status === 'active' ? '在籍中' : '在籍外'}`;
    document.getElementById('employee-detail-basic-fields').innerHTML =
      fieldRow('フリガナ', p.furigana) + fieldRow('生年月日', p.birth_date ? new Date(p.birth_date).toLocaleDateString('ja-JP') : null) +
      fieldRow('入社日', p.hire_date ? new Date(p.hire_date).toLocaleDateString('ja-JP') : null) + fieldRow('所属/役割', p.department) +
      fieldRow('権限', p.request_role === 'executive' ? '管理者' : '一般社員') +
      fieldRow('メールアドレス', p.email) + fieldRow('電話番号', p.phone) + fieldRow('郵便番号', p.postal_code) + fieldRow('住所', p.address) +
      fieldRow('緊急連絡先(氏名)', p.emergency_contact_name) + fieldRow('緊急連絡先(続柄)', p.emergency_contact_relation) + fieldRow('緊急連絡先(電話番号)', p.emergency_contact_phone);
  } catch (e) { /* 無視 */ }
}

async function loadEmployeeDetailLeave() {
  const session = getSession();
  const code = currentEmployeeDetailCode;
  const listEl = document.getElementById('employee-detail-leave-history');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_employee_admin_summary', { p_admin_employee_code: session.employeeCode, p_target_employee_code: code });
    const s = rows && rows[0];
    document.getElementById('employee-detail-leave-balance').textContent = s && s.leave_balance != null ? `${s.leave_balance}日` : '未登録';
    document.getElementById('employee-detail-leave-used').textContent = s ? `${s.leave_used_this_year}日` : '-';
    listEl.innerHTML = '<div class="hint">支給品履歴・詳しい取得履歴は各タブ/画面をご確認ください。</div>';
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function loadEmployeeDetailQual() {
  const session = getSession();
  const listEl = document.getElementById('employee-detail-qual-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const nameRows = await rpc('admin_get_employee_profile', { p_admin_employee_code: session.employeeCode, p_target_employee_code: currentEmployeeDetailCode });
    const targetName = nameRows && nameRows[0] && nameRows[0].employee_name;
    const rows = await rpc('admin_list_qualifications', { p_admin_employee_code: session.employeeCode, p_filter: null });
    const mine = (rows || []).filter((q) => q.employee_name === targetName);
    if (mine.length === 0) { listEl.innerHTML = '<div class="hint">登録された資格はありません。</div>'; return; }
    listEl.innerHTML = mine.map((q) => `
      <div class="qual-item">
        <div class="row1"><span>${q.qualification_name}</span><span class="status-badge ${q.status === 'active' ? 'done' : (q.status === 'rejected' ? 'rejected' : '')}">${QUAL_STATUS_LABEL[q.status] || q.status}</span></div>
        <div class="row2">${q.expiry_date ? `有効期限: ${new Date(q.expiry_date).toLocaleDateString('ja-JP')}` : ''}</div>
      </div>
    `).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function loadEmployeeDetailSupply() {
  const session = getSession();
  const listEl = document.getElementById('employee-detail-supply-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_supply_admin_list', { p_admin_employee_code: session.employeeCode, p_employee_code: currentEmployeeDetailCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">支給履歴はありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => `
      <div class="supply-item">
        <div class="row1"><span>${r.item_name}</span><span>${r.quantity}個</span></div>
        <div class="row2">支給日: ${r.issued_date}${r.size ? `・サイズ${r.size}` : ''}${r.condition === 'used' ? '・中古' : '・新品'}</div>
        <div class="elapsed">経過${formatElapsed(r.elapsed_days)}${r.needs_return ? (r.returned_date ? `・返却済(${r.returned_date})` : '・未返却') : ''}</div>
      </div>
    `).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function loadEmployeeDetailRequests() {
  const session = getSession();
  const listEl = document.getElementById('employee-detail-requests-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_get_employee_requests', { p_admin_employee_code: session.employeeCode, p_target_employee_code: currentEmployeeDetailCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">申請履歴はありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => {
      const amountStr = r.amount != null ? `${Number(r.amount).toLocaleString()}円` : '';
      const statusClass = ['approved', 'paid'].includes(r.status) ? 'done' : (['rejected', 'cancelled'].includes(r.status) ? 'rejected' : '');
      return `
        <div class="history-item">
          <div class="row1"><span>${REQUEST_TYPE_LABEL[r.request_type] || r.request_type}</span><span>${amountStr}</span></div>
          <div class="row2">${new Date(r.requested_at).toLocaleDateString('ja-JP')}　${r.summary || ''}</div>
          <span class="status-badge ${statusClass}">${STATUS_LABEL[r.status] || r.status}</span>
        </div>
      `;
    }).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

function openEmployeeEditBasic() {
  document.getElementById('employee-edit-furigana').value = '';
  document.getElementById('employee-edit-birth').value = '';
  document.getElementById('employee-edit-department').value = '';
  hideError('employee-edit-error');
  showScreen('employee-edit-basic');
}

async function doSaveEmployeeBasic() {
  const session = getSession();
  const furigana = document.getElementById('employee-edit-furigana').value.trim();
  const birth = document.getElementById('employee-edit-birth').value;
  const department = document.getElementById('employee-edit-department').value.trim();
  hideError('employee-edit-error');
  const btn = document.getElementById('employee-edit-submit');
  btn.disabled = true;
  try {
    await rpc('admin_update_employee_basic', {
      p_admin_employee_code: session.employeeCode, p_target_employee_code: currentEmployeeDetailCode,
      p_furigana: furigana || null, p_birth_date: birth || null, p_department: department || null,
    });
    showScreen('employee-detail');
    await loadEmployeeDetailBasic();
  } catch (e) {
    showError('employee-edit-error', e.message || '保存に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 支給品マスター管理(管理者) ----------

async function loadSupplyMasterAdmin() {
  const session = getSession();
  const listEl = document.getElementById('supply-master-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  resetSupplyMasterForm();
  try {
    const rows = await rpc('admin_list_supply_master', { p_admin_employee_code: session.employeeCode });
    listEl.innerHTML = rows.map((m) => `
      <div class="supply-item" data-id="${m.id}" style="${m.active ? '' : 'opacity:.5;'}">
        <div class="row1"><span>${m.item_name}</span><span>${m.active ? '有効' : '停止中'}</span></div>
        <div class="row2">${m.requires_size ? 'サイズ入力あり' : 'サイズ入力なし'}・表示順${m.sort_order}</div>
        <div class="qual-verify-btns">
          <button type="button" class="edit-master-btn" data-name="${m.item_name}" data-requires-size="${m.requires_size}" data-sort="${m.sort_order}">編集</button>
          <button type="button" class="reject-btn toggle-active-btn" data-active="${m.active}">${m.active ? '停止する' : '再開する'}</button>
        </div>
      </div>
    `).join('');
    listEl.querySelectorAll('.edit-master-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = btn.closest('.supply-item');
        document.getElementById('supply-master-edit-id').value = item.dataset.id;
        document.getElementById('supply-master-name').value = btn.dataset.name;
        document.getElementById('supply-master-requires-size').checked = btn.dataset.requiresSize === 'true';
        document.getElementById('supply-master-sort').value = btn.dataset.sort;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
    listEl.querySelectorAll('.toggle-active-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = btn.closest('.supply-item');
        await rpc('admin_set_supply_master_active', { p_admin_employee_code: session.employeeCode, p_id: Number(item.dataset.id), p_active: btn.dataset.active !== 'true' });
        loadSupplyMasterAdmin();
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

function resetSupplyMasterForm() {
  document.getElementById('supply-master-edit-id').value = '';
  document.getElementById('supply-master-name').value = '';
  document.getElementById('supply-master-requires-size').checked = false;
  document.getElementById('supply-master-sort').value = '100';
  hideError('supply-master-error');
}

async function doSaveSupplyMasterItem() {
  const session = getSession();
  const id = document.getElementById('supply-master-edit-id').value;
  const name = document.getElementById('supply-master-name').value.trim();
  const requiresSize = document.getElementById('supply-master-requires-size').checked;
  const sortOrder = Number(document.getElementById('supply-master-sort').value || 100);
  hideError('supply-master-error');
  if (!name) { showError('supply-master-error', '品目名を入力してください。'); return; }

  const btn = document.getElementById('supply-master-submit');
  btn.disabled = true;
  try {
    await rpc('admin_upsert_supply_master_item', {
      p_admin_employee_code: session.employeeCode, p_id: id ? Number(id) : null, p_item_name: name,
      p_requires_size: requiresSize, p_sort_order: sortOrder,
    });
    await loadSupplyMasterAdmin();
  } catch (e) {
    showError('supply-master-error', e.message || '保存に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 初期化 ----------

function init() {
  hydrateIcons(document);

  document.getElementById('login-btn').addEventListener('click', doSubmitEmployeeCode);
  document.getElementById('login-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSubmitEmployeeCode(); });

  document.getElementById('pin-entry-submit').addEventListener('click', doVerifyPin);
  document.getElementById('pin-entry-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doVerifyPin(); });
  document.getElementById('pin-entry-switch').addEventListener('click', switchEmployee);

  document.getElementById('pin-register-submit').addEventListener('click', doRegisterPin);
  document.getElementById('pin-register-switch').addEventListener('click', switchEmployee);

  document.getElementById('logout-btn').addEventListener('click', switchEmployee);
  document.getElementById('logout-btn-2').addEventListener('click', switchEmployee);

  document.getElementById('leave-submit').addEventListener('click', doSubmitLeave);
  ['leave-start', 'leave-end', 'leave-half'].forEach((id) => {
    document.getElementById(id).addEventListener('change', updateLeaveDaysDisplay);
  });

  document.getElementById('expense-add-item').addEventListener('click', () => addExpenseItem());
  document.getElementById('expense-submit').addEventListener('click', doSubmitExpense);
  document.getElementById('expense-batch-input').addEventListener('change', (e) => {
    addExpenseItemsBatch(e.target.files);
    e.target.value = '';
  });

  document.getElementById('meeting-submit').addEventListener('click', doSubmitMeeting);

  document.getElementById('supply-req-submit').addEventListener('click', doSubmitSupplyRequest);

  document.getElementById('admin-employee-select').addEventListener('change', loadAdminEmployeeDetail);
  document.getElementById('admin-issue-submit').addEventListener('click', doAdminRecordIssuance);
  document.getElementById('admin-search-btn').addEventListener('click', doAdminSearch);
  document.getElementById('admin-reset-pin-btn').addEventListener('click', doAdminResetPin);

  document.getElementById('anon-submit-btn').addEventListener('click', doSubmitAnonConsultation);
  document.getElementById('anon-thread-send').addEventListener('click', doSendAnonThreadMessage);
  document.getElementById('anon-admin-status-filter').addEventListener('change', loadAnonAdminList);
  document.getElementById('anon-admin-status-select').addEventListener('change', doAdminChangeAnonStatus);
  document.getElementById('anon-admin-reply-btn').addEventListener('click', doAdminReplyAnon);

  document.getElementById('announce-submit').addEventListener('click', doCreateAnnouncement);
  document.querySelectorAll('input[name="announce-target"]').forEach((el) => {
    el.addEventListener('change', () => {
      const showSelect = document.getElementById('announce-target-select').checked;
      document.getElementById('announce-employee-select').style.display = showSelect ? '' : 'none';
      document.getElementById('announce-target-hint').style.display = showSelect ? '' : 'none';
    });
  });

  document.getElementById('qual-submit').addEventListener('click', doSubmitQualification);
  document.getElementById('qual-photo-input').addEventListener('change', (e) => handleQualFile(e.target.files[0], 'photo'));
  document.getElementById('qual-pdf-input').addEventListener('change', (e) => handleQualFile(e.target.files[0], 'pdf'));
  document.getElementById('qual-admin-filter').addEventListener('change', loadQualAdminList);

  document.getElementById('profile-edit-submit').addEventListener('click', doSubmitProfileEdit);
  document.getElementById('info-change-filter').addEventListener('change', loadInfoChangeAdmin);
  document.getElementById('supply-master-submit').addEventListener('click', doSaveSupplyMasterItem);
  document.getElementById('employee-detail-edit-basic-btn').addEventListener('click', openEmployeeEditBasic);
  document.getElementById('employee-edit-submit').addEventListener('click', doSaveEmployeeBasic);
  document.getElementById('admin-issue-master').addEventListener('change', toggleAdminIssueOtherWrap);

  document.querySelectorAll('#employee-detail-tabs .tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchEmployeeDetailTab(btn.dataset.tab));
  });

  document.querySelectorAll('#employee-status-filter .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#employee-status-filter .filter-chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      employeeStatusFilter = btn.dataset.status;
      loadEmployeeDirectory();
    });
  });
  document.getElementById('employee-search-input').addEventListener('input', () => {
    clearTimeout(employeeSearchTimer);
    employeeSearchTimer = setTimeout(loadEmployeeDirectory, 300);
  });

  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => {
      const target = el.getAttribute('data-nav');
      if (el.disabled) return;
      if (target === 'menu') { enterMenu(); return; }
      if (target === 'expense-advance') { enterExpenseScreen('employee_advance'); return; }
      if (target === 'expense-company') { enterExpenseScreen('company_expense'); return; }
      showScreen(target);
    });
  });

  SCREEN_ENTER_HOOKS.leave = () => { updateLeaveDaysDisplay(); loadLeaveBalance(); };
  SCREEN_ENTER_HOOKS['leave-history'] = loadLeaveHistory;
  SCREEN_ENTER_HOOKS.history = loadHistory;
  SCREEN_ENTER_HOOKS['supply-request'] = () => { hideError('supply-req-error'); loadSupplySelectGrid(); };
  SCREEN_ENTER_HOOKS['my-supply'] = loadMySupply;
  SCREEN_ENTER_HOOKS.myinfo = loadMyInfo;
  SCREEN_ENTER_HOOKS['my-change-requests'] = loadMyChangeRequests;
  SCREEN_ENTER_HOOKS.admin = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadAdminEmployeeSelects();
    document.getElementById('admin-search-results').innerHTML = '';
  };
  SCREEN_ENTER_HOOKS['anon-consult'] = loadMyAnonConsultations;
  SCREEN_ENTER_HOOKS['anon-submit'] = () => { hideError('anon-submit-error'); document.getElementById('anon-content').value = ''; };
  SCREEN_ENTER_HOOKS['anon-admin'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadAnonAdminList();
  };
  SCREEN_ENTER_HOOKS.announcements = loadAnnouncements;
  SCREEN_ENTER_HOOKS['admin-dashboard'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadAdminDashboard();
  };
  SCREEN_ENTER_HOOKS['admin-request-list'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadAdminRequestList();
  };
  SCREEN_ENTER_HOOKS['admin-announce'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    hideError('announce-error');
    loadAnnounceAdminEmployeeSelect();
    loadAnnounceAdminList();
  };
  SCREEN_ENTER_HOOKS['menu-apply'] = () => loadHomeLeaveStats('home-leave-balance', 'home-leave-used');
  SCREEN_ENTER_HOOKS['qual-submit'] = resetQualForm;
  SCREEN_ENTER_HOOKS['my-qual'] = loadMyQualifications;
  SCREEN_ENTER_HOOKS['qual-admin'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadQualAdminList();
  };
  SCREEN_ENTER_HOOKS['category-review'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadCategoryReview();
  };
  SCREEN_ENTER_HOOKS['employee-directory'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    document.getElementById('employee-search-input').value = '';
    employeeStatusFilter = 'active';
    document.querySelectorAll('#employee-status-filter .filter-chip').forEach((b) => b.classList.toggle('active', b.dataset.status === 'active'));
    loadEmployeeDirectory();
  };
  SCREEN_ENTER_HOOKS['info-change-admin'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadInfoChangeAdmin();
  };
  SCREEN_ENTER_HOOKS['supply-master-admin'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadSupplyMasterAdmin();
  };

  const session = getSession();
  if (session && session.employeeId) {
    enterMenu();
  } else {
    startLoginFlow();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
