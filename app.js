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

// new Date().toISOString()はUTC日付になるため、深夜0時〜9時JSTの間は「今日」が
// 前日にずれてしまう(日報の未提出判定・自動確認・通知は日本時間の暦日で行う必要がある)。
// 日報関連の「今日の日付」は必ずこの関数で取得する。
function todayJST() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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
  meeting: 'menu-apply', 'supply-request': 'menu-apply', 'qual-submit': 'menu-apply', 'health-submit': 'menu-apply',
  'entertainment-submit': 'menu-apply', 'daily-report': 'menu-apply',
  announcements: 'announcements',
  history: 'history',
  myinfo: 'myinfo', 'leave-history': 'myinfo', 'my-supply': 'myinfo', 'my-qual': 'myinfo', 'my-health': 'myinfo',
  'my-change-requests': 'myinfo', 'profile-edit': 'myinfo', 'anon-consult': 'myinfo', 'anon-submit': 'myinfo',
  'anon-done': 'myinfo', 'anon-thread': 'myinfo', 'my-entertainment': 'myinfo', 'my-daily-reports': 'myinfo',
  'entertainment-update': 'myinfo',
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

// スマホのハードウェア/ジェスチャーの「戻る」に対応するため、画面遷移のたびに
// history.pushStateで積んでおく(popstateから呼ぶ場合はfromPopstate:trueにして
// 積み直さない)。これが無いと「戻る」操作がアプリ内遷移として扱われず、
// アプリ自体が終了・ホーム画面に戻る等の予期しない挙動になってしまう。
function showScreen(id, opts) {
  opts = opts || {};
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
  document.getElementById(`screen-${id}`).classList.add('active');
  const preAuthScreens = ['login', 'pin-entry', 'pin-register'];
  document.getElementById('bottom-nav').style.display = preAuthScreens.includes(id) ? 'none' : 'flex';
  document.querySelectorAll('.bottom-nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-nav') === (BOTTOM_NAV_MAP[id] || id));
  });
  if (!opts.fromPopstate && !preAuthScreens.includes(id)) {
    history.pushState({ screen: id }, '', location.pathname + location.search);
  }
  window.scrollTo(0, 0);
  if (SCREEN_ENTER_HOOKS[id]) SCREEN_ENTER_HOOKS[id]();
}

window.addEventListener('popstate', (e) => {
  if (!getSession()) return; // ログイン前はブラウザ標準の戻る動作に任せる
  const id = (e.state && e.state.screen) || 'menu';
  if (document.getElementById(`screen-${id}`)) showScreen(id, { fromPopstate: true });
});

// 各種申請の完了画面(screen-done)は共通だが、「メニューに戻る」を常にホームへ
// 固定すると申請のたびにホームへ戻されて不便なため、申請元の画面へ戻れるように
// 遷移先を呼び出し側から指定できるようにする。
// 「差し戻す」「却下する」を押すと理由入力欄が下に表示される作りだが、ボタンの
// すぐ下に表示されるだけだと画面の下に隠れて何も起きていないように見えるため、
// 表示と同時にスクロールしてテキストエリアへフォーカスする。
function revealReasonBox(boxEl) {
  boxEl.style.display = 'block';
  boxEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const textarea = boxEl.querySelector('textarea');
  if (textarea) setTimeout(() => textarea.focus(), 300);
}

function showDone(message, returnTo) {
  document.getElementById('done-message').textContent = message;
  document.querySelector('#screen-done [data-nav]').setAttribute('data-nav', returnTo || 'menu');
  showScreen('done');
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
  checkAnonUnreadBadge().then(loadTodayList);
  loadAnnounceBanner();
  loadHomeAnnouncePreview();
  showScreen('menu');
  renderHomeAdminBanner(session);
}

// executiveはadmin-dashboard(全管理メニュー)、日報担当(nippo_admin、executiveではない)は
// 日報管理画面への専用入口を表示する。nippo_adminはrequestRole(セッションに直接入っている値)
// では判定できず、都度サーバーへ確認が必要(check_nippo_admin RPC)なため非同期。
// admin-dashboard自体がisAdmin()(executive)限定のため、この入口が無いとnippo_adminは
// 日報管理画面へ辿り着く手段が無くなってしまう。
async function renderHomeAdminBanner(session) {
  const bannerArea = document.getElementById('admin-banner-area');
  const showAdmin = session.requestRole === 'executive';
  let html = '';
  if (showAdmin) {
    html = `
      <button type="button" class="main-menu-card" data-nav="admin-dashboard" style="width:100%; flex-direction:row; align-items:center; gap:14px; margin-top:8px;">
        <span class="main-menu-card-icon">${icon('shield')}</span>
        <span style="text-align:left;">
          <span class="main-menu-label" style="display:block;">管理者ダッシュボード</span>
          <span class="main-menu-desc">承認待ち・社員管理をまとめて確認</span>
        </span>
        <span style="margin-left:auto; color:var(--text-faint);">${icon('chevron-right')}</span>
      </button>
    `;
  } else if (await isNippoAdmin()) {
    html = `
      <button type="button" class="main-menu-card" data-nav="daily-report-management" style="width:100%; flex-direction:row; align-items:center; gap:14px; margin-top:8px;">
        <span class="main-menu-card-icon">${icon('clipboard-list')}</span>
        <span style="text-align:left;">
          <span class="main-menu-label" style="display:block;">日報管理(日報担当)</span>
          <span class="main-menu-desc">日報の確認・未提出者確認・外注代理入力</span>
        </span>
        <span style="margin-left:auto; color:var(--text-faint);">${icon('chevron-right')}</span>
      </button>
    `;
  }
  bannerArea.innerHTML = html;
  bannerArea.querySelectorAll('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => showScreen(el.getAttribute('data-nav')));
  });
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
    showDone('有給休暇申請を受け付けました。承認をお待ちください。', 'menu-apply');
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

// 取引先マスター(business_partners)から候補を読み込み、datalistで検索型選択を実現する。
// 入力値がマスターの名称と完全一致すればbusiness_partner_id、一致しなければ新規取引先名として
// 送信する(vendorNameToIdは送信時の解決に使う)。
let vendorNameToId = new Map();
async function populateVendorList() {
  try {
    const rows = await rpc('search_business_partners', { p_query: null });
    vendorNameToId = new Map(rows.map((v) => [v.partner_name, v.id]));
    document.getElementById('vendor-list').innerHTML = rows.map((v) => `<option value="${v.partner_name}">`).join('');
  } catch (e) { /* 取引先候補が引けなくても自由入力は継続できる */ }
}

// 使用目的マスター(expense_purpose_master、管理者のみ追加・編集・無効化可)から検索して選択する。
// 表記揺れ(「接待」「接待費」等がバラバラに保存される)を防ぐため、自由入力は許可しない
// (site-selectと同じ「検索→select」の方式)。
async function populatePurposeSelect(selectEl, query) {
  try {
    const rows = await rpc('search_expense_purposes', { p_query: query || null });
    const current = selectEl.value;
    selectEl.innerHTML = '<option value="">選択してください</option>' + rows.map((p) => `<option value="${p.name}">${p.name}</option>`).join('');
    if (current && rows.some((p) => p.name === current)) selectEl.value = current;
  } catch (e) { /* 候補が引けなくても他の項目は引き続き入力できる */ }
}

// 取引先参加者名を複数登録できる簡易チップ入力(検索は不要な自由記入の氏名リスト)。
// HTML側(expense-item-template)に既にある入力欄・追加ボタン・チップ表示欄を配線するだけで、
// マークアップの再生成はしない(打ち合わせ項目の他の要素を巻き込んで消さないため)。
function wirePartnerParticipantChips(card) {
  const names = [];
  const input = card.querySelector('.item-partner-participant-input');
  const chips = card.querySelector('.item-partner-participant-chips');

  function renderChips() {
    chips.innerHTML = names.map((n, i) => `
      <span class="participant-chip" data-idx="${i}">${n}<button type="button">${icon('x-circle')}</button></span>
    `).join('');
    chips.querySelectorAll('.participant-chip button').forEach((btn) => {
      btn.addEventListener('click', () => {
        names.splice(Number(btn.closest('.participant-chip').dataset.idx), 1);
        renderChips();
      });
    });
  }

  function addName() {
    const v = input.value.trim();
    if (!v) return;
    names.push(v);
    input.value = '';
    renderChips();
  }

  card.querySelector('.item-partner-participant-add-btn').addEventListener('click', addName);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addName(); }
  });

  return {
    getNames() { return names.slice(); },
    // 接待事前申請の紐付け時、取引先参加者名(「、」区切りの文字列)から事前反映するために使う。
    setNames(namesText) {
      names.length = 0;
      (namesText || '').split(/[、,]/).map((n) => n.trim()).filter(Boolean).forEach((n) => names.push(n));
      renderChips();
    },
  };
}

// 打ち合わせ・接待交際費の「自社参加者」複数選択(検索→タップで選択、チップで表示)。
function createParticipantSelect(container) {
  const selected = new Map();
  container.innerHTML = `
    <input type="text" class="participant-search-input" placeholder="氏名・社員番号で検索...">
    <div class="participant-results"></div>
    <div class="participant-chips"></div>
  `;
  const input = container.querySelector('.participant-search-input');
  const results = container.querySelector('.participant-results');
  const chips = container.querySelector('.participant-chips');
  let allEmployees = [];
  let onChange = null;

  const employeesLoaded = (async () => {
    const session = getSession();
    try { allEmployees = await rpc('list_employees_for_participant_select', { p_employee_code: session.employeeCode }); } catch (e) { /* 無視 */ }
  })();

  function renderChips() {
    chips.innerHTML = Array.from(selected.entries()).map(([code, name]) => `
      <span class="participant-chip" data-code="${code}">${name}<button type="button">${icon('x-circle')}</button></span>
    `).join('');
    chips.querySelectorAll('.participant-chip button').forEach((btn) => {
      btn.addEventListener('click', () => {
        selected.delete(btn.closest('.participant-chip').dataset.code);
        renderChips();
        if (onChange) onChange();
      });
    });
  }

  input.addEventListener('input', () => {
    const q = input.value.trim();
    const matches = allEmployees.filter((e) => !selected.has(e.employee_code) && (q === '' || e.employee_name.includes(q) || e.employee_code.includes(q))).slice(0, 8);
    results.innerHTML = matches.map((e, i) => `<button type="button" class="participant-result-item" data-idx="${i}">${e.employee_name}(${e.employee_code})</button>`).join('');
    results.querySelectorAll('.participant-result-item').forEach((el, i) => {
      el.addEventListener('click', () => {
        selected.set(matches[i].employee_code, matches[i].employee_name);
        input.value = '';
        results.innerHTML = '';
        renderChips();
        if (onChange) onChange();
      });
    });
  });

  return {
    setOnChange(cb) { onChange = cb; },
    getSelectedCodes() { return Array.from(selected.keys()); },
    getCount() { return selected.size; },
    // 接待事前申請の紐付け時、自社参加者を候補データから事前選択するために使う。
    async setSelectedCodes(codes) {
      await employeesLoaded;
      selected.clear();
      (codes || []).forEach((code) => {
        const emp = allEmployees.find((e) => e.employee_code === code);
        selected.set(code, emp ? emp.employee_name : code);
      });
      renderChips();
      if (onChange) onChange();
    },
  };
}

const participantSelects = new Map(); // itemId -> インスタンス(経費明細ごとの自社参加者選択)

// 領収書の日付・店舗・金額から、承認済みの接待事前申請を検索して紐付け候補を出す。
async function searchAndShowPreapprovals(card, itemId) {
  const area = card.querySelector('.preapproval-search-area');
  const session = getSession();
  const date = card.querySelector('.item-date').value || null;
  const store = card.querySelector('.item-store').value.trim() || null;
  const amount = card.querySelector('.item-amount').value || null;
  const state = expenseItemState.get(itemId);
  area.innerHTML = '<div class="hint">承認済みの事前申請を確認しています...</div>';
  let candidates = [];
  try {
    candidates = await rpc('search_my_entertainment_preapprovals', {
      p_employee_code: session.employeeCode, p_near_date: date, p_near_store: store, p_near_amount: amount ? Number(amount) : null,
    });
  } catch (e) { /* 検索できなくても手動での判断に委ねる */ }

  if (candidates.length > 0) {
    area.innerHTML = '<div class="item-suggest-label">この接待の事前申請を選んでタップしてください</div>' + candidates.map((c, i) => `
      <div class="preapproval-candidate" data-idx="${i}">
        <div class="row1"><span>${c.planned_store || '(店舗未記入)'}</span><span>${c.planned_amount != null ? Number(c.planned_amount).toLocaleString() + '円' : ''}</span></div>
        <div class="row2">${new Date(c.planned_datetime).toLocaleString('ja-JP')}・${c.partner_name_snapshot || ''}</div>
      </div>
    `).join('');
    area.querySelectorAll('.preapproval-candidate').forEach((el, i) => {
      el.addEventListener('click', () => {
        area.querySelectorAll('.preapproval-candidate').forEach((x) => x.classList.remove('linked'));
        el.classList.add('linked');
        state.entertainmentPreapprovalId = candidates[i].id;

        // 事前申請で入力済みの情報を自動反映する(同じ内容を二度入力させない)。
        const c = candidates[i];
        if (c.business_partner_id) {
          vendorNameToId.set(c.partner_name_snapshot, c.business_partner_id);
          card.querySelector('.item-vendor').value = c.partner_name_snapshot || '';
        }
        if (!card.querySelector('.item-date').value && c.planned_datetime) {
          card.querySelector('.item-date').value = new Date(c.planned_datetime).toISOString().slice(0, 10);
        }
        if (!card.querySelector('.item-purpose').value && c.purpose) {
          card.querySelector('.item-purpose').value = c.purpose;
        }
        if (c.partner_participants && state.partnerParticipantChips) state.partnerParticipantChips.setNames(c.partner_participants);
        if (c.partner_participant_count) card.querySelector('.item-partner-count').value = c.partner_participant_count;
        const pSelect = participantSelects.get(itemId);
        if (pSelect && c.our_participant_employee_codes) {
          pSelect.setSelectedCodes(c.our_participant_employee_codes).then(() => {
            card.querySelector('.item-our-count').textContent = pSelect.getCount();
          });
        }
      });
    });
  } else {
    state.entertainmentPreapprovalId = null;
    const admin = session.requestRole === 'executive';
    area.innerHTML = `<div class="preapproval-warning">${icon('alert-triangle')}事前申請が確認できないため、この接待交際費は通常の経費として申請できません。「接待・会食」から先に事前申請してください。</div>`
      + (admin ? `
        <div class="preapproval-override-box">
          <label>例外理由(管理者のみ入力可)<span class="required-mark">(必須)</span></label>
          <textarea class="item-override-reason" placeholder="例: 先方都合で急遽実施、事前申請の時間が取れなかった"></textarea>
        </div>
      ` : '');
  }
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
    html += '<option value="__new__">該当する現場がない/新しい現場を入力</option>';
    selectEl.innerHTML = html;
    if (current && (rows.some((s) => String(s.id) === current) || current === '__new__')) selectEl.value = current;
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
  const newSiteWrap = clone.querySelector('.item-new-site-wrap');
  const newSiteToggleBtn = clone.querySelector('.item-new-site-toggle-btn');
  populateSiteSelect(siteSelect, '');
  siteSearch.addEventListener('input', () => populateSiteSelect(siteSelect, siteSearch.value.trim()));
  siteSelect.addEventListener('change', () => {
    if (siteSelect.value === '__new__') newSiteWrap.style.display = 'block';
  });
  // ネイティブselectの選択肢の中に埋もれて「新しい現場を入力」が見つけにくい実機があるため、
  // 常に見える専用ボタンからも同じ新規入力欄を開けるようにする(selectとボタン、どちらからでも入力可)。
  newSiteToggleBtn.addEventListener('click', () => {
    siteSelect.value = '__new__';
    newSiteWrap.style.display = 'block';
    const cardEl = document.querySelector(`[data-item-id="${itemId}"]`);
    if (cardEl) cardEl.querySelector('.item-new-site-name').focus();
  });

  const purposeCategorySelect = clone.querySelector('.item-purpose-category');
  const purposeSearch = clone.querySelector('.item-purpose-search');
  const meetingBlock = clone.querySelector('.item-meeting-block');
  const entertainmentBlock = clone.querySelector('.item-entertainment-block');
  const partnerParticipantChips = wirePartnerParticipantChips(clone.querySelector('.item-meeting-block'));
  populatePurposeSelect(purposeCategorySelect, '');
  purposeSearch.addEventListener('input', () => populatePurposeSelect(purposeCategorySelect, purposeSearch.value.trim()));
  let lastEntertainmentSearchKey = '';
  function syncPurposeCategory() {
    const cat = purposeCategorySelect.value;
    const needsMeeting = cat === '取引先との打ち合わせ' || cat === '接待交際費';
    meetingBlock.style.display = needsMeeting ? 'block' : 'none';
    entertainmentBlock.style.display = cat === '接待交際費' ? 'block' : 'none';
    if (needsMeeting && !participantSelects.has(itemId)) {
      const cardEl = document.querySelector(`[data-item-id="${itemId}"]`);
      const inst = createParticipantSelect(cardEl.querySelector('.participant-select'));
      inst.setOnChange(() => { cardEl.querySelector('.item-our-count').textContent = inst.getCount(); });
      participantSelects.set(itemId, inst);
    }
    if (cat === '接待交際費' && lastEntertainmentSearchKey !== cat) {
      lastEntertainmentSearchKey = cat;
      const cardEl = document.querySelector(`[data-item-id="${itemId}"]`);
      searchAndShowPreapprovals(cardEl, itemId);
    } else if (cat !== '接待交際費') {
      lastEntertainmentSearchKey = '';
    }
  }
  purposeCategorySelect.addEventListener('change', syncPurposeCategory);
  expenseItemState.get(itemId).partnerParticipantChips = partnerParticipantChips;

  clone.querySelector('.remove-item-btn').addEventListener('click', () => {
    document.querySelector(`[data-item-id="${itemId}"]`).remove();
    expenseItemState.delete(itemId);
    participantSelects.delete(itemId);
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
  participantSelects.clear();
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
    const payment = card.querySelector('.item-payment').value;
    const note = card.querySelector('.item-note').value.trim();
    const label = card.querySelector('.item-label').textContent;
    const purposeCategory = card.querySelector('.item-purpose-category').value.trim();
    const purpose = card.querySelector('.item-purpose').value.trim();

    if (state.uploading) { showError('expense-error', `${label}: 写真のアップロード中です。少しお待ちください。`); return; }
    if (!state.driveFileId) { showError('expense-error', `${label}: 領収書またはレシートの写真を添付してください。`); return; }
    if (!date || !store || !amount) { showError('expense-error', `${label}: 利用日・支払先・金額は必須です。`); return; }
    if (!purposeCategory) { showError('expense-error', `${label}: 使用目的のカテゴリを選択してください。`); return; }
    if (['その他', '取引先との打ち合わせ', '接待交際費'].includes(purposeCategory) && !purpose) {
      showError('expense-error', `${label}: 使用目的の詳細を入力してください。`); return;
    }

    const siteSelect = card.querySelector('.item-site-select');
    let siteId = siteSelect.value || null;
    let newSiteName = null;
    let siteName = null;
    if (siteId === '__new__') {
      newSiteName = card.querySelector('.item-new-site-name').value.trim();
      if (!newSiteName) { showError('expense-error', `${label}: 新しい現場名を入力してください。`); return; }
      siteId = null;
    } else if (!siteId) {
      showError('expense-error', `${label}: 現場を選択してください。`); return;
    } else {
      siteName = siteSelect.options[siteSelect.selectedIndex].dataset.name;
    }

    const vendorText = card.querySelector('.item-vendor').value.trim();
    const businessPartnerId = vendorNameToId.get(vendorText) || null;
    const newBusinessPartnerName = (!businessPartnerId && vendorText) ? vendorText : null;

    let partnerParticipants = null;
    let partnerCount = null;
    let ourCodes = null;
    const needsMeeting = purposeCategory === '取引先との打ち合わせ' || purposeCategory === '接待交際費';
    if (needsMeeting) {
      if (!businessPartnerId && !newBusinessPartnerName) { showError('expense-error', `${label}: 取引先を選択または入力してください。`); return; }
      const chipNames = state.partnerParticipantChips ? state.partnerParticipantChips.getNames() : [];
      partnerParticipants = chipNames.length > 0 ? chipNames.join('、') : null;
      partnerCount = Number(card.querySelector('.item-partner-count').value || 0);
      if (!partnerCount) { showError('expense-error', `${label}: 取引先の参加人数を入力してください。`); return; }
      const pSelect = participantSelects.get(itemId);
      ourCodes = pSelect ? pSelect.getSelectedCodes() : [];
      if (ourCodes.length === 0) { showError('expense-error', `${label}: 自社参加者を選択してください。`); return; }
    }

    let entertainmentPreapprovalId = null;
    let overrideReason = null;
    if (purposeCategory === '接待交際費') {
      entertainmentPreapprovalId = state.entertainmentPreapprovalId || null;
      if (!entertainmentPreapprovalId) {
        if (session.requestRole === 'executive') {
          const reasonEl = card.querySelector('.item-override-reason');
          overrideReason = reasonEl ? reasonEl.value.trim() : '';
          if (!overrideReason) { showError('expense-error', `${label}: 事前申請が確認できないため、この接待交際費は通常の経費として申請できません。管理者の場合は例外理由を入力してください。`); return; }
        } else {
          showError('expense-error', `${label}: 事前申請が確認できないため、この接待交際費は通常の経費として申請できません。「接待・会食」から先に事前申請してください。`); return;
        }
      }
    }

    items.push({
      document_date: date, store, amount, tax_amount: tax ? Number(tax) : null,
      site_id: siteId, site_name: siteName, new_site_name: newSiteName,
      business_partner_id: businessPartnerId, new_business_partner_name: newBusinessPartnerName, vendor_name: vendorText || null,
      purpose_category: purposeCategory, purpose,
      partner_participants: partnerParticipants, partner_participant_count: partnerCount,
      our_participant_employee_codes: ourCodes,
      entertainment_preapproval_id: entertainmentPreapprovalId, admin_override_reason: overrideReason,
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
    showDone(`${label}を受け付けました(${r ? r.item_count : items.length}件、合計${r ? Number(r.total_amount).toLocaleString() : ''}円)。承認をお待ちください。`, 'menu-apply');
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
    showDone('会議申請を受け付けました。承認をお待ちください。', 'menu-apply');
    ['meeting-date', 'meeting-place', 'meeting-headcount', 'meeting-content', 'meeting-amount'].forEach((id) => { document.getElementById(id).value = ''; });
    document.getElementById('meeting-meal').checked = false;
  } catch (e) {
    showError('meeting-error', '送信に失敗しました。もう一度お試しください。');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 申請履歴 ----------

const REQUEST_TYPE_LABEL = {
  paid_leave: '有給休暇申請', expense_reimbursement: '経費立替申請', meeting: '会議申請', supply_item: '支給品申請',
  entertainment_preapproval: '接待事前申請', qualification: '資格・免許', other: 'その他',
};
const STATUS_LABEL = {
  ready_for_review: '確認中', waiting_employee_info: '差し戻し(要修正)', needs_review: '確認中', stopped: '処理停止',
  waiting_approval: '承認待ち', approved: '承認済み', rejected: '却下', on_hold: '保留',
  waiting_payment: '支払待ち', paid: '支払済み', cancelled: '取消',
  pending: '確認待ち', pending_verification: '確認待ち', active: '有効', expired: '期限切れ',
};
const STATUS_GROUP_LABEL = { pending: '承認待ち', needs_review: '差し戻し(要修正)', special_review: '特別承認待ち', approved: '承認済み', rejected: '却下' };

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
    cards.push({ id: 'other', name: '上記以外', requiresSize: false, icon: 'plus' });
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
  document.getElementById('supply-req-selected-title').textContent = isOther ? '上記以外の支給品' : el.dataset.name;
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
    showDone('支給品申請を受け付けました。承認をお待ちください。', 'menu-apply');
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

// nippo_adminは既存のrequest_role(session)には現れないため、都度サーバーへ確認する。
// 同一タブ内での連打を避けるため軽くキャッシュする(ログイン中の権限変更は稀なため許容)。
let _nippoAdminCache = null;
async function isNippoAdmin() {
  if (isAdmin()) return true;
  if (_nippoAdminCache !== null) return _nippoAdminCache;
  const session = getSession();
  try {
    _nippoAdminCache = await rpc('check_nippo_admin', { p_employee_code: session.employeeCode });
  } catch (e) { _nippoAdminCache = false; }
  return _nippoAdminCache;
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
    select.innerHTML = active.map((m) => `<option value="${m.id}" data-requires-size="${m.requires_size}">${m.item_name}</option>`).join('') + '<option value="">上記以外(自由入力)</option>';
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
          <span class="title">${a.importance === 'important' ? `<span class="icon-slot" data-icon="alert-triangle"></span> ` : ''}${a.title}</span>
          <span class="date">${new Date(a.created_at).toLocaleDateString('ja-JP')}</span>
        </div>
        <div class="body">${a.body}${a.attachment_url ? `<br><a href="${a.attachment_url}" target="_blank" rel="noopener">添付ファイルを開く</a>` : ''}</div>
        ${a.importance === 'important' ? `
          <div class="announce-ack-row">
            ${a.acknowledged_at
              ? `<span class="mini-tag info">確認済み(${new Date(a.acknowledged_at).toLocaleString('ja-JP')})</span>`
              : `<button type="button" class="secondary announce-ack-btn">確認しました</button>`}
          </div>
        ` : ''}
      </div>
    `).join('');
    hydrateIcons(listEl);
    listEl.querySelectorAll('.announce-item').forEach((el) => {
      el.addEventListener('click', async (e) => {
        if (e.target.closest('.announce-ack-btn') || e.target.closest('a')) return;
        const wasUnread = el.classList.contains('unread');
        el.classList.toggle('expanded');
        if (wasUnread) {
          el.classList.remove('unread');
          try { await rpc('mark_announcement_read', { p_employee_code: session.employeeCode, p_announcement_id: Number(el.dataset.id) }); } catch (e2) { /* 無視 */ }
        }
      });
    });
    listEl.querySelectorAll('.announce-ack-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const item = btn.closest('.announce-item');
        try {
          await rpc('acknowledge_announcement', { p_employee_code: session.employeeCode, p_announcement_id: Number(item.dataset.id) });
          loadAnnouncements();
        } catch (e3) { /* 無視 */ }
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
  { key: 'pending_sites', filter: null, label: '新規現場の確認待ち', icon: 'map-pin', nav: 'site-admin' },
  { key: 'pending_entertainment_preapprovals', filter: null, label: '接待事前申請 承認待ち', icon: 'users-round', nav: 'entertainment-admin' },
  { key: 'health_checkup_overdue_count', filter: null, label: '健診 期限超過', icon: 'check-circle', nav: 'health-admin', healthFilter: 'overdue' },
  { key: 'health_checkup_due_soon_count', filter: null, label: '健診 期限間近', icon: 'clock', nav: 'health-admin', healthFilter: 'due_soon' },
  { key: 'health_checkup_retest_pending_count', filter: null, label: '再検査確認待ち', icon: 'alert-triangle', nav: 'health-admin', healthFilter: 'retest' },
  { key: 'today_submissions_count', filter: null, label: '本日の申請', icon: 'clock', nav: 'admin-all-requests', areqFilter: { type: '', status: '' } },
  { key: 'approved_recent_count', filter: null, label: '承認済み(30日)', icon: 'check-circle', nav: 'admin-all-requests', areqFilter: { type: '', status: 'approved' } },
  { key: 'rejected_recent_count', filter: null, label: '却下(30日)', icon: 'x-circle', nav: 'admin-all-requests', areqFilter: { type: '', status: 'rejected' } },
  { key: 'entertainment_special_review_count', filter: null, label: '接待: 後日申請(特別承認待ち)', icon: 'alert-triangle', nav: 'admin-all-requests', areqFilter: { type: 'entertainment_preapproval', status: 'special_review' } },
  { key: 'entertainment_override_count', filter: null, label: '接待: 事前申請なし(例外承認累計)', icon: 'users-round', nav: 'entertainment-admin' },
  { key: 'daily_report_exception_count', filter: null, label: '日報: 特殊ケース未対応', icon: 'clipboard-list', nav: 'daily-report-admin' },
];

async function loadAdminDashboard() {
  const session = getSession();
  const grid = document.getElementById('admin-dashboard-grid');
  grid.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_admin_dashboard', { p_admin_employee_code: session.employeeCode });
    const d = rows && rows[0];
    grid.innerHTML = DASH_CARDS.map((c, i) => {
      const count = d ? d[c.key] : 0;
      return `
        <button type="button" class="dash-card" data-idx="${i}">
          <span class="dash-card-top">${icon(c.icon)}<span class="dash-card-count ${count === 0 ? 'zero' : 'alert'}">${count}</span></span>
          <span class="dash-card-label">${c.label}</span>
        </button>
      `;
    }).join('');
    grid.querySelectorAll('.dash-card').forEach((el) => {
      el.addEventListener('click', () => {
        const c = DASH_CARDS[Number(el.dataset.idx)];
        if (c.healthFilter) {
          healthAdminFilter = c.healthFilter;
          document.querySelectorAll('#screen-health-admin .filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.healthFilter === c.healthFilter));
        }
        if (c.areqFilter) {
          areqFilters = { type: c.areqFilter.type || '', status: c.areqFilter.status || '', name: '', dateFrom: '', dateTo: '', site: '', partner: '' };
        }
        if (c.nav) {
          showScreen(c.nav);
          if (c.areqFilter) {
            document.querySelectorAll('#areq-type-filter .filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.type === areqFilters.type));
            document.querySelectorAll('#areq-status-filter .filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.status === areqFilters.status));
          }
          return;
        }
        openAdminRequestList(c.filter);
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
        revealReasonBox(e.target.closest('.history-item').querySelector('.reject-reason-box'));
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

let announceAllEmployees = [];
const announceSelectedCodes = new Set();
let announceAttachment = null; // { driveFileId, driveFileUrl }

function renderAnnounceEmployeeChecklist(query) {
  const listEl = document.getElementById('announce-employee-checklist');
  const q = (query || '').trim();
  const matches = announceAllEmployees.filter((e) => q === '' || e.employee_name.includes(q) || e.employee_code.includes(q));
  listEl.innerHTML = matches.map((e) => `
    <label class="checkbox-row" style="margin:0;">
      <input type="checkbox" class="announce-emp-check" value="${e.employee_code}" ${announceSelectedCodes.has(e.employee_code) ? 'checked' : ''}>
      <span>${e.employee_name}(${e.employee_code})</span>
    </label>
  `).join('');
  listEl.querySelectorAll('.announce-emp-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) announceSelectedCodes.add(cb.value); else announceSelectedCodes.delete(cb.value);
      document.getElementById('announce-employee-selected-count').textContent = announceSelectedCodes.size;
    });
  });
}

async function loadAnnounceAdminEmployeeSelect() {
  const session = getSession();
  try {
    announceAllEmployees = await rpc('list_active_employees', { p_admin_employee_code: session.employeeCode });
    renderAnnounceEmployeeChecklist('');
  } catch (e) { /* 無視 */ }
}

async function handleAnnounceAttachment(file) {
  if (!file) return;
  const statusEl = document.getElementById('announce-attachment-status');
  const labelEl = document.getElementById('announce-attachment-label');
  statusEl.textContent = 'アップロード中...';
  try {
    const session = getSession();
    const result = await uploadReceiptPhoto(session.employeeCode, file);
    announceAttachment = { driveFileId: result.driveFileId, driveFileUrl: result.driveFileUrl };
    labelEl.textContent = file.name;
    statusEl.textContent = 'アップロード完了';
  } catch (e) {
    statusEl.textContent = 'アップロードに失敗しました。もう一度お試しください。';
    announceAttachment = null;
  }
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
    employeeCodes = Array.from(announceSelectedCodes);
    if (employeeCodes.length === 0) { showError('announce-error', '配信先の社員を選択してください。'); return; }
  }
  const btn = document.getElementById('announce-submit');
  btn.disabled = true;
  try {
    await rpc('admin_create_announcement', {
      p_admin_employee_code: session.employeeCode, p_title: title, p_body: body,
      p_importance: importance, p_employee_codes: employeeCodes,
      p_attachment_drive_file_id: announceAttachment ? announceAttachment.driveFileId : null,
      p_attachment_drive_url: announceAttachment ? announceAttachment.driveFileUrl : null,
    });
    document.getElementById('announce-title').value = '';
    document.getElementById('announce-body').value = '';
    document.getElementById('announce-importance-normal').checked = true;
    document.getElementById('announce-target-all').checked = true;
    document.getElementById('announce-employee-picker').style.display = 'none';
    announceSelectedCodes.clear();
    document.getElementById('announce-employee-selected-count').textContent = '0';
    document.getElementById('announce-attachment-label').textContent = 'ファイルを選ぶ';
    document.getElementById('announce-attachment-status').textContent = '';
    announceAttachment = null;
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
        <div class="row1"><span>${a.importance === 'important' ? `<span class="icon-slot" data-icon="alert-triangle"></span> ` : ''}${a.title}</span><span>${a.read_count}/${a.recipient_count} 既読</span></div>
        <div class="row2">${new Date(a.created_at).toLocaleString('ja-JP')}${a.source_system !== 'admin_manual' ? `・自動通知(${a.source_system})` : ''}${a.importance === 'important' ? `・確認済み${a.acknowledged_count}/${a.recipient_count}` : ''}</div>
      </div>
    `).join('');
    hydrateIcons(listEl);
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
        ${r.acknowledged_at ? `<span class="mini-tag info">確認済み ${new Date(r.acknowledged_at).toLocaleString('ja-JP')}</span>` : ''}
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

function setQualCategory(category) {
  document.getElementById('qual-category').value = category;
  const isLicense = category === 'license';
  document.getElementById('qual-category-qualification').classList.toggle('secondary-off', isLicense);
  document.getElementById('qual-category-license').classList.toggle('secondary-off', !isLicense);
  document.getElementById('qual-name-wrap').style.display = isLicense ? 'none' : 'block';
  document.getElementById('qual-license-type-wrap').style.display = isLicense ? 'block' : 'none';
  if (isLicense) loadLicenseTypeSelect();
}

async function loadLicenseTypeSelect() {
  try {
    const rows = await rpc('list_license_types', {});
    document.getElementById('qual-license-type').innerHTML = rows.map((t) => `<option value="${t.id}">${t.type_name}</option>`).join('');
  } catch (e) { /* 無視 */ }
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
  setQualCategory('qualification');
}

async function doSubmitQualification() {
  const session = getSession();
  const category = document.getElementById('qual-category').value;
  const name = document.getElementById('qual-name').value.trim();
  const licenseTypeId = document.getElementById('qual-license-type').value || null;
  hideError('qual-error');
  if (category === 'qualification' && !name) { showError('qual-error', '資格名を入力してください。'); return; }
  if (category === 'license' && !licenseTypeId) { showError('qual-error', '免許種別を選択してください。'); return; }
  const btn = document.getElementById('qual-submit');
  btn.disabled = true;
  try {
    await rpc('submit_qualification', {
      p_employee_code: session.employeeCode,
      p_qualification_name: category === 'qualification' ? name : null,
      p_qualification_number: document.getElementById('qual-number').value.trim() || null,
      p_obtained_date: document.getElementById('qual-obtained').value || null,
      p_expiry_date: document.getElementById('qual-expiry').value || null,
      p_renewal_deadline: document.getElementById('qual-renewal').value || null,
      p_note: document.getElementById('qual-note').value.trim() || null,
      p_photo_drive_file_id: qualPhotoUpload ? qualPhotoUpload.driveFileId : null,
      p_photo_drive_file_url: qualPhotoUpload ? qualPhotoUpload.driveFileUrl : null,
      p_pdf_drive_file_id: qualPdfUpload ? qualPdfUpload.driveFileId : null,
      p_pdf_drive_file_url: qualPdfUpload ? qualPdfUpload.driveFileUrl : null,
      p_category: category,
      p_license_type_id: category === 'license' ? Number(licenseTypeId) : null,
    });
    resetQualForm();
    showDone(`${category === 'license' ? '免許' : '資格'}を登録しました。管理者の確認をお待ちください。`, 'menu-apply');
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
          <div class="row1"><span>${q.category === 'license' ? '<span class="mini-tag info">免許</span> ' : ''}${q.qualification_name}</span><span class="status-badge ${q.status === 'active' ? 'done' : (q.status === 'rejected' ? 'rejected' : '')}">${QUAL_STATUS_LABEL[q.status] || q.status}</span></div>
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

let qualAdminCategoryFilter = '';

async function loadQualAdminList() {
  const session = getSession();
  const filter = document.getElementById('qual-admin-filter').value || null;
  const listEl = document.getElementById('qual-admin-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_qualifications', { p_admin_employee_code: session.employeeCode, p_filter: filter, p_category: qualAdminCategoryFilter || null });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">該当する資格・免許はありません。</div>'; return; }
    listEl.innerHTML = rows.map((q) => {
      const expiring = q.status === 'active' && q.days_until_expiry != null && q.days_until_expiry <= 60;
      const expiryText = q.expiry_date ? `有効期限: ${new Date(q.expiry_date).toLocaleDateString('ja-JP')}${q.days_until_expiry != null ? `(残り${q.days_until_expiry}日)` : ''}` : '期限未登録';
      return `
        <div class="qual-item ${expiring ? 'expiring' : ''}" data-id="${q.id}">
          <div class="row1"><span>${q.category === 'license' ? '<span class="mini-tag info">免許</span> ' : ''}${q.employee_name}・${q.qualification_name}</span><span class="status-badge ${q.status === 'active' ? 'done' : (q.status === 'rejected' ? 'rejected' : '')}">${QUAL_STATUS_LABEL[q.status] || q.status}</span></div>
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
    showDone('変更を申請しました。管理者が確認したうえで反映されます。', 'myinfo');
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

async function openEmployeeDetail(code, initialTab) {
  currentEmployeeDetailCode = code;
  const tab = initialTab || 'basic';
  currentEmployeeDetailTab = tab;
  document.querySelectorAll('#employee-detail-tabs .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('#screen-employee-detail .tab-panel').forEach((p) => p.classList.toggle('active', p.id === `employee-detail-panel-${tab}`));
  showScreen('employee-detail');
  await switchEmployeeDetailTab(tab);
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
  const healthArea = document.getElementById('employee-detail-health-summary');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  healthArea.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const healthRows = await rpc('admin_get_employee_health_summary', { p_admin_employee_code: session.employeeCode, p_target_employee_code: currentEmployeeDetailCode });
    const h = healthRows && healthRows[0];
    healthArea.innerHTML = `
      <div class="health-summary-card">
        <div class="row"><span class="label">最終受診日</span><span>${h && h.last_checkup_date ? new Date(h.last_checkup_date).toLocaleDateString('ja-JP') : '未登録'}</span></div>
        <div class="row"><span class="label">次回予定</span><span>${h && h.next_due_date ? new Date(h.next_due_date).toLocaleDateString('ja-JP') : '未登録'}</span></div>
        ${h && h.is_overdue ? '<div class="row"><span class="label">状態</span><span style="color:var(--danger); font-weight:700;">期限超過</span></div>' : ''}
        ${h && h.needs_retest ? '<div class="row"><span class="label">状態</span><span style="color:var(--warn); font-weight:700;">再検査確認待ち</span></div>' : ''}
      </div>
    `;

    const nameRows = await rpc('admin_get_employee_profile', { p_admin_employee_code: session.employeeCode, p_target_employee_code: currentEmployeeDetailCode });
    const targetName = nameRows && nameRows[0] && nameRows[0].employee_name;
    const rows = await rpc('admin_list_qualifications', { p_admin_employee_code: session.employeeCode, p_filter: null, p_category: null });
    const mine = (rows || []).filter((q) => q.employee_name === targetName);
    if (mine.length === 0) { listEl.innerHTML = '<div class="hint">登録された資格・免許はありません。</div>'; return; }
    listEl.innerHTML = mine.map((q) => `
      <div class="qual-item">
        <div class="row1"><span>${q.category === 'license' ? '<span class="mini-tag info">免許</span> ' : ''}${q.qualification_name}</span><span class="status-badge ${q.status === 'active' ? 'done' : (q.status === 'rejected' ? 'rejected' : '')}">${QUAL_STATUS_LABEL[q.status] || q.status}</span></div>
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
      const statusClass = r.status_group === 'approved' ? 'done' : (r.status_group === 'rejected' ? 'rejected' : '');
      return `
        <div class="history-item">
          <div class="row1"><span>${REQUEST_TYPE_LABEL[r.source_type] || r.source_type}</span><span>${amountStr}</span></div>
          <div class="row2">${new Date(r.requested_at).toLocaleDateString('ja-JP')}　${r.summary || ''}</div>
          <span class="status-badge ${statusClass}">${STATUS_LABEL[r.status] || STATUS_GROUP_LABEL[r.status_group] || r.status}</span>
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

// ---------- 健康診断(社員本人) ----------

let healthFileUpload = null;

async function handleHealthFile(file) {
  if (!file) return;
  const status = document.getElementById('health-file-status');
  const label = document.getElementById('health-file-label');
  status.textContent = 'アップロード中...';
  try {
    const session = getSession();
    const result = await uploadReceiptPhoto(session.employeeCode, file);
    healthFileUpload = result;
    status.textContent = 'アップロード完了';
    label.textContent = file.name;
  } catch (e) {
    status.textContent = 'アップロードに失敗しました。';
  }
}

function resetHealthForm() {
  ['health-date', 'health-type', 'health-institution', 'health-next', 'health-note'].forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('health-retest').checked = false;
  document.getElementById('health-file-input').value = '';
  document.getElementById('health-file-label').textContent = '写真/PDFを選ぶ';
  document.getElementById('health-file-status').textContent = '';
  healthFileUpload = null;
  hideError('health-error');
}

async function doSubmitHealthCheckup() {
  const session = getSession();
  const date = document.getElementById('health-date').value;
  hideError('health-error');
  if (!date) { showError('health-error', '受診日を入力してください。'); return; }
  const btn = document.getElementById('health-submit');
  btn.disabled = true;
  try {
    await rpc('submit_health_checkup', {
      p_employee_code: session.employeeCode,
      p_checkup_date: date,
      p_checkup_type: document.getElementById('health-type').value.trim() || null,
      p_institution: document.getElementById('health-institution').value.trim() || null,
      p_next_due_date: document.getElementById('health-next').value || null,
      p_needs_retest: document.getElementById('health-retest').checked,
      p_note: document.getElementById('health-note').value.trim() || null,
      p_result_drive_file_id: healthFileUpload ? healthFileUpload.driveFileId : null,
      p_result_drive_file_url: healthFileUpload ? healthFileUpload.driveFileUrl : null,
    });
    resetHealthForm();
    showDone('健康診断の記録を登録しました。', 'menu-apply');
  } catch (e) {
    showError('health-error', e.message || '送信に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

function healthStatusText(s) {
  if (!s || !s.last_checkup_date) return '未登録です';
  const last = new Date(s.last_checkup_date).toLocaleDateString('ja-JP');
  const next = s.next_due_date ? new Date(s.next_due_date).toLocaleDateString('ja-JP') : '未登録';
  let status = '';
  if (s.is_overdue) status = '(期限を超えています)';
  else if (s.days_until_due != null && s.days_until_due <= 60) status = `(残り${s.days_until_due}日)`;
  return `最終受診日: ${last} ／ 次回予定: ${next}${status}`;
}

async function loadMyHealthSummary() {
  const session = getSession();
  const area = document.getElementById('my-health-summary');
  area.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_health_summary', { p_employee_code: session.employeeCode });
    const s = rows && rows[0];
    area.innerHTML = `
      <div class="health-summary-card">
        <div class="row"><span class="label">最終受診日</span><span>${s && s.last_checkup_date ? new Date(s.last_checkup_date).toLocaleDateString('ja-JP') : '未登録'}</span></div>
        <div class="row"><span class="label">次回予定</span><span>${s && s.next_due_date ? new Date(s.next_due_date).toLocaleDateString('ja-JP') : '未登録'}</span></div>
        ${s && s.is_overdue ? '<div class="row"><span class="label">状態</span><span style="color:var(--danger); font-weight:700;">期限超過</span></div>' : ''}
        ${s && s.needs_retest ? '<div class="row"><span class="label">状態</span><span style="color:var(--warn); font-weight:700;">再検査確認待ち</span></div>' : ''}
      </div>
    `;
  } catch (e) {
    area.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function loadMyHealthList() {
  const session = getSession();
  const listEl = document.getElementById('my-health-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_health_checkups', { p_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">登録された健診記録はまだありません。</div>'; return; }
    listEl.innerHTML = rows.map((h) => `
      <div class="qual-item">
        <div class="row1"><span>${new Date(h.checkup_date).toLocaleDateString('ja-JP')}${h.checkup_type ? `・${h.checkup_type}` : ''}</span><span class="status-badge ${h.result_confirmed ? 'done' : ''}">${h.result_confirmed ? '確認済み' : '未確認'}</span></div>
        <div class="row2">${h.institution || ''}</div>
        <div class="row2">${h.next_due_date ? `次回予定: ${new Date(h.next_due_date).toLocaleDateString('ja-JP')}` : ''}${h.needs_retest ? '・再検査あり' : ''}</div>
        <div class="row2">${h.note || ''}</div>
        ${h.result_file_url ? `<a class="file-link" href="${h.result_file_url}" target="_blank" rel="noopener">結果を見る</a>` : ''}
      </div>
    `).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// ---------- 接待・会食 事前申請(社員) ----------

let entOurParticipantSelect = null;

function resetEntertainmentForm() {
  ['ent-datetime', 'ent-store', 'ent-amount', 'ent-purpose', 'ent-partner', 'ent-partner-participants', 'ent-partner-count', 'ent-note'].forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('ent-partner-id').value = '';
  hideError('ent-error');
  entOurParticipantSelect = createParticipantSelect(document.getElementById('ent-our-participants'));
  entOurParticipantSelect.setOnChange(() => { document.getElementById('ent-our-count').textContent = entOurParticipantSelect.getCount(); });
  document.getElementById('ent-our-count').textContent = '0';
}

async function doSubmitEntertainmentPreapproval() {
  const session = getSession();
  const datetime = document.getElementById('ent-datetime').value;
  const purpose = document.getElementById('ent-purpose').value.trim();
  const partnerText = document.getElementById('ent-partner').value.trim();
  const partnerCount = Number(document.getElementById('ent-partner-count').value || 0);
  hideError('ent-error');

  if (!datetime) { showError('ent-error', '予定日時を入力してください。'); return; }
  if (!purpose) { showError('ent-error', '目的を入力してください。'); return; }
  if (!partnerText) { showError('ent-error', '取引先を選択または入力してください。'); return; }
  if (!partnerCount) { showError('ent-error', '取引先の参加人数を入力してください。'); return; }
  const ourCodes = entOurParticipantSelect ? entOurParticipantSelect.getSelectedCodes() : [];
  if (ourCodes.length === 0) { showError('ent-error', '自社参加者を選択してください。'); return; }

  const partnerId = vendorNameToId.get(partnerText) || null;

  const btn = document.getElementById('ent-submit');
  btn.disabled = true;
  try {
    await rpc('submit_entertainment_preapproval', {
      p_employee_code: session.employeeCode,
      p_planned_datetime: new Date(datetime).toISOString(),
      p_planned_store: document.getElementById('ent-store').value.trim() || null,
      p_planned_amount: document.getElementById('ent-amount').value ? Number(document.getElementById('ent-amount').value) : null,
      p_purpose: purpose,
      p_business_partner_id: partnerId,
      p_new_partner_name: partnerId ? null : partnerText,
      p_partner_participants: document.getElementById('ent-partner-participants').value.trim() || null,
      p_partner_participant_count: partnerCount,
      p_our_participant_employee_codes: ourCodes,
      p_note: document.getElementById('ent-note').value.trim() || null,
    });
    showDone('接待・会食の事前申請を送信しました。管理者の承認をお待ちください。', 'menu-apply');
  } catch (e) {
    showError('ent-error', e.message || '送信に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

const ENT_STATUS_LABEL = { pending: '確認待ち', approved: '承認済み', rejected: '却下' };

const ENT_TIMING_TAG_CLASS = { '事前申請': 'info', '当日事後申請': 'warn', '後日申請': 'danger' };

async function loadMyEntertainmentList() {
  const session = getSession();
  const listEl = document.getElementById('my-entertainment-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_entertainment_preapprovals', { p_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">事前申請はまだありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => `
      <div class="qual-item" data-id="${r.id}">
        <div class="row1"><span>${r.planned_store || '(店舗未記入)'}</span><span class="status-badge ${r.status === 'approved' ? 'done' : (r.status === 'rejected' ? 'rejected' : '')}">${ENT_STATUS_LABEL[r.status]}</span></div>
        <div class="row2">${new Date(r.planned_datetime).toLocaleString('ja-JP')}・${r.partner_name_snapshot || ''}</div>
        <div class="row2">${r.purpose || ''}${r.planned_amount != null ? `・予定${Number(r.planned_amount).toLocaleString()}円` : ''}</div>
        <div class="row2">実績: 取引先${r.actual_partner_participant_count ?? '-'}名/自社${r.actual_our_participant_count ?? '-'}名・紐付き領収書${r.linked_receipt_count}件</div>
        <div class="employee-row-flags" style="margin-top:6px;">
          <span class="mini-tag ${ENT_TIMING_TAG_CLASS[r.submission_timing] || 'muted'}">${r.submission_timing || ''}</span>
          ${r.requires_special_review ? '<span class="mini-tag danger">事前申請なし(特別承認)</span>' : ''}
        </div>
        <div class="qual-verify-btns">
          <button type="button" class="update-actuals-btn">実績を更新する</button>
        </div>
      </div>
    `).join('');
    listEl.querySelectorAll('.update-actuals-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => openEntertainmentUpdate(e.target.closest('.qual-item').dataset.id));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

let entUpdateOurParticipantSelect = null;

async function openEntertainmentUpdate(id) {
  const session = getSession();
  document.getElementById('ent-update-id').value = id;
  hideError('ent-update-error');
  document.getElementById('ent-update-partner-participants').value = '';
  document.getElementById('ent-update-partner-count').value = '';
  document.getElementById('ent-update-note').value = '';
  document.getElementById('ent-update-planned-summary').textContent = '読み込み中...';
  document.getElementById('ent-update-history').innerHTML = '';
  showScreen('entertainment-update');

  const rows = await rpc('get_my_entertainment_preapprovals', { p_employee_code: session.employeeCode });
  const r = rows.find((x) => String(x.id) === String(id));
  if (r) {
    document.getElementById('ent-update-planned-summary').textContent =
      `当初の予定: ${new Date(r.planned_datetime).toLocaleString('ja-JP')}・${r.partner_name_snapshot || ''}・取引先${r.partner_participant_count ?? '-'}名/自社${r.our_participant_count ?? '-'}名`;
    document.getElementById('ent-update-partner-count').value = r.actual_partner_participant_count || '';
  }

  entUpdateOurParticipantSelect = createParticipantSelect(document.getElementById('ent-update-our-participants'));
  entUpdateOurParticipantSelect.setOnChange(() => {
    document.getElementById('ent-update-our-count').textContent = entUpdateOurParticipantSelect.getCount();
  });

  try {
    const changes = await rpc('get_entertainment_preapproval_changes', { p_employee_code: session.employeeCode, p_id: Number(id) });
    const historyEl = document.getElementById('ent-update-history');
    if (!changes || changes.length === 0) { historyEl.innerHTML = '<div class="hint">変更履歴はありません。</div>'; return; }
    historyEl.innerHTML = changes.map((c) => {
      const d = c.detail || {};
      let body = '';
      if (c.action === 'entertainment_preapproval_submitted') {
        body = `事前申請を提出(${d.submission_timing || ''})`;
      } else if (c.action === 'entertainment_preapproval_actuals_updated') {
        const parts = [];
        if (d.added && d.added.length) parts.push(`追加: ${d.added.join('、')}`);
        if (d.removed && d.removed.length) parts.push(`削除: ${d.removed.join('、')}`);
        if (d.old_partner_participants !== d.new_partner_participants) parts.push(`取引先参加者を変更`);
        body = `実績を更新${parts.length ? '(' + parts.join('・') + ')' : ''}${d.note ? '・' + d.note : ''}`;
      } else if (c.action === 'entertainment_preapproval_late_exception_approval') {
        body = `管理者が例外承認(理由: ${d.reason || ''})`;
      } else {
        body = c.action;
      }
      return `<div class="change-request-item"><div class="row1"><span>${body}</span></div><div class="row2">${c.actor_name}・${new Date(c.created_at).toLocaleString('ja-JP')}</div></div>`;
    }).join('');
  } catch (e) { /* 履歴が取れなくても更新フォームは使える */ }
}

async function doUpdateEntertainmentActuals() {
  const session = getSession();
  const id = document.getElementById('ent-update-id').value;
  const partnerParticipants = document.getElementById('ent-update-partner-participants').value.trim() || null;
  const partnerCount = Number(document.getElementById('ent-update-partner-count').value || 0);
  const note = document.getElementById('ent-update-note').value.trim() || null;
  hideError('ent-update-error');
  if (!partnerCount) { showError('ent-update-error', '取引先の参加人数を入力してください。'); return; }
  const ourCodes = entUpdateOurParticipantSelect ? entUpdateOurParticipantSelect.getSelectedCodes() : [];
  if (ourCodes.length === 0) { showError('ent-update-error', '自社参加者を選択してください。'); return; }

  const btn = document.getElementById('ent-update-submit');
  btn.disabled = true;
  try {
    await rpc('update_entertainment_preapproval_actuals', {
      p_employee_code: session.employeeCode, p_id: Number(id),
      p_actual_partner_participants: partnerParticipants, p_actual_partner_participant_count: partnerCount,
      p_actual_our_participant_employee_codes: ourCodes, p_note: note,
    });
    showScreen('my-entertainment');
  } catch (e) {
    showError('ent-update-error', e.message || '保存に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 接待事前申請の承認(管理者) ----------

async function loadEntertainmentAdminList() {
  const session = getSession();
  const status = document.getElementById('entertainment-admin-filter').value || null;
  const listEl = document.getElementById('entertainment-admin-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_entertainment_preapprovals', { p_admin_employee_code: session.employeeCode, p_status: status });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">該当する事前申請はありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => `
      <div class="qual-item" data-id="${r.id}">
        <div class="row1"><span>${r.employee_name}・${r.planned_store || '(店舗未記入)'}</span><span class="status-badge ${r.status === 'approved' ? 'done' : (r.status === 'rejected' ? 'rejected' : '')}">${ENT_STATUS_LABEL[r.status]}</span></div>
        <div class="row2">${new Date(r.planned_datetime).toLocaleString('ja-JP')}・${r.partner_name_snapshot || ''}(取引先${r.partner_participant_count ?? '-'}名/自社${r.our_participant_count ?? '-'}名)</div>
        <div class="row2">${r.purpose || ''}${r.planned_amount != null ? `・予定${Number(r.planned_amount).toLocaleString()}円` : ''}</div>
        <div class="row2">登録日時: ${new Date(r.created_at).toLocaleString('ja-JP')}</div>
        <div class="employee-row-flags" style="margin-top:6px;">
          <span class="mini-tag ${ENT_TIMING_TAG_CLASS[r.submission_timing] || 'muted'}">${r.submission_timing || ''}</span>
        </div>
        ${r.requires_special_review ? `<div class="preapproval-warning">${icon('alert-triangle')}この接待は事前申請されていません。内容を確認のうえ、例外承認または却下してください。</div>` : ''}
        ${r.exception_reason ? `<div class="row2">例外承認理由: ${r.exception_reason}</div>` : ''}
        ${r.status === 'pending' ? `
          ${r.requires_special_review ? `
            <label>例外承認の理由<span class="required-mark">(必須)</span></label>
            <textarea class="ent-exception-reason" placeholder="例: 先方都合で急遽実施、事前に把握はしていた"></textarea>
          ` : ''}
          <div class="qual-verify-btns">
            <button type="button" class="approve-btn">${r.requires_special_review ? '例外承認する' : '承認する'}</button>
            <button type="button" class="reject-btn">却下する</button>
          </div>
        ` : ''}
      </div>
    `).join('');
    listEl.querySelectorAll('.approve-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const item = e.target.closest('.qual-item');
        const reasonEl = item.querySelector('.ent-exception-reason');
        doDecideEntertainment(item.dataset.id, 'approved', reasonEl ? reasonEl.value.trim() : null);
      });
    });
    listEl.querySelectorAll('.reject-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => doDecideEntertainment(e.target.closest('.qual-item').dataset.id, 'rejected', null));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doDecideEntertainment(id, action, exceptionReason) {
  const session = getSession();
  try {
    await rpc('admin_decide_entertainment_preapproval', { p_admin_employee_code: session.employeeCode, p_id: Number(id), p_action: action, p_exception_reason: exceptionReason || null });
    await loadEntertainmentAdminList();
  } catch (e) {
    window.alert(e.message || '操作に失敗しました。');
  }
}

// ---------- 現場管理(管理者・日報担当) ----------

async function loadSiteAdminList() {
  const session = getSession();
  const listEl = document.getElementById('site-admin-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_pending_sites', { p_admin_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">確認待ちの新規現場はありません。</div>'; return; }
    listEl.innerHTML = rows.map((s) => `
      <div class="qual-item" data-id="${s.id}">
        <div class="row1"><input type="text" class="site-rename-input" value="${s.site_name}"></div>
        <div class="row2">${new Date(s.created_at).toLocaleString('ja-JP')}</div>
        <div class="qual-verify-btns">
          <button type="button" class="approve-btn">承認する</button>
          <button type="button" class="reject-btn">却下する</button>
        </div>
      </div>
    `).join('');
    listEl.querySelectorAll('.approve-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => doDecideSite(e.target.closest('.qual-item'), 'active'));
    });
    listEl.querySelectorAll('.reject-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => doDecideSite(e.target.closest('.qual-item'), 'inactive'));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
  loadAllSitesList();
}

async function doDecideSite(itemEl, action) {
  const session = getSession();
  const id = itemEl.dataset.id;
  const renamedTo = itemEl.querySelector('.site-rename-input').value.trim();
  try {
    if (action === 'active' && renamedTo) {
      await rpc('admin_update_site_name', { p_admin_employee_code: session.employeeCode, p_site_id: Number(id), p_site_name: renamedTo });
    }
    await rpc('admin_decide_pending_site', { p_admin_employee_code: session.employeeCode, p_site_id: Number(id), p_action: action });
    await loadSiteAdminList();
  } catch (e) { /* 失敗時は一覧が更新されないだけ */ }
}

async function doCreateSite() {
  const session = getSession();
  const nameInput = document.getElementById('site-create-name');
  const name = nameInput.value.trim();
  hideError('site-create-error');
  if (!name) { showError('site-create-error', '現場名を入力してください。'); return; }
  try {
    await rpc('admin_create_site', { p_admin_employee_code: session.employeeCode, p_site_name: name });
    nameInput.value = '';
    await loadSiteAdminList();
  } catch (e) {
    showError('site-create-error', e.message || '登録に失敗しました。');
  }
}

let siteListQuery = '';
async function loadAllSitesList() {
  const session = getSession();
  const listEl = document.getElementById('site-all-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_sites', { p_admin_employee_code: session.employeeCode, p_include_inactive: true, p_query: siteListQuery || null });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">該当する現場はありません。</div>'; return; }
    const statusLabel = { active: '有効', pending: '承認待ち', inactive: '無効' };
    listEl.innerHTML = rows.map((s) => `
      <div class="qual-item" data-id="${s.id}">
        <div class="row1"><input type="text" class="site-rename-input" value="${s.site_name}"><span class="mini-tag ${s.status === 'active' ? 'info' : (s.status === 'pending' ? 'danger' : '')}">${statusLabel[s.status] || s.status}</span></div>
        <div class="qual-verify-btns">
          <button type="button" class="site-save-btn">名前を保存</button>
        </div>
      </div>
    `).join('');
    listEl.querySelectorAll('.site-save-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const item = e.target.closest('.qual-item');
        const newName = item.querySelector('.site-rename-input').value.trim();
        if (!newName) return;
        try {
          await rpc('admin_update_site_name', { p_admin_employee_code: session.employeeCode, p_site_id: Number(item.dataset.id), p_site_name: newName });
          await loadAllSitesList();
        } catch (e2) { window.alert(e2.message || '保存に失敗しました。'); }
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// ---------- 免許種別マスター管理(管理者) ----------

function resetLicenseTypeForm() {
  document.getElementById('license-type-edit-id').value = '';
  document.getElementById('license-type-name').value = '';
  document.getElementById('license-type-sort').value = '100';
  hideError('license-type-error');
}

async function loadLicenseTypeAdminList() {
  const session = getSession();
  const listEl = document.getElementById('license-type-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  resetLicenseTypeForm();
  try {
    const rows = await rpc('admin_list_license_types', { p_admin_employee_code: session.employeeCode });
    listEl.innerHTML = rows.map((t) => `
      <div class="supply-item" data-id="${t.id}" style="${t.active ? '' : 'opacity:.5;'}">
        <div class="row1"><span>${t.type_name}</span><span>${t.active ? '有効' : '停止中'}</span></div>
        <div class="row2">表示順${t.sort_order}</div>
        <div class="qual-verify-btns">
          <button type="button" class="edit-license-btn" data-name="${t.type_name}" data-sort="${t.sort_order}">編集</button>
          <button type="button" class="reject-btn toggle-license-btn" data-active="${t.active}">${t.active ? '停止する' : '再開する'}</button>
        </div>
      </div>
    `).join('');
    listEl.querySelectorAll('.edit-license-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = btn.closest('.supply-item');
        document.getElementById('license-type-edit-id').value = item.dataset.id;
        document.getElementById('license-type-name').value = btn.dataset.name;
        document.getElementById('license-type-sort').value = btn.dataset.sort;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
    listEl.querySelectorAll('.toggle-license-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = btn.closest('.supply-item');
        await rpc('admin_set_license_type_active', { p_admin_employee_code: session.employeeCode, p_id: Number(item.dataset.id), p_active: btn.dataset.active !== 'true' });
        loadLicenseTypeAdminList();
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doSaveLicenseType() {
  const session = getSession();
  const id = document.getElementById('license-type-edit-id').value;
  const name = document.getElementById('license-type-name').value.trim();
  const sort = Number(document.getElementById('license-type-sort').value || 100);
  hideError('license-type-error');
  if (!name) { showError('license-type-error', '種別名を入力してください。'); return; }
  const btn = document.getElementById('license-type-submit');
  btn.disabled = true;
  try {
    await rpc('admin_upsert_license_type', { p_admin_employee_code: session.employeeCode, p_id: id ? Number(id) : null, p_type_name: name, p_sort_order: sort });
    await loadLicenseTypeAdminList();
  } catch (e) {
    showError('license-type-error', e.message || '保存に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 健康診断管理(管理者) ----------

let healthAdminFilter = '';

async function loadHealthAdminList() {
  const session = getSession();
  const listEl = document.getElementById('health-admin-warning-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_health_warnings', { p_admin_employee_code: session.employeeCode, p_filter: healthAdminFilter || null });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">該当する社員はいません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => `
      <div class="employee-row" data-code="${r.employee_code}">
        <div class="employee-avatar">${(r.employee_name || '?').charAt(0)}</div>
        <div class="employee-row-body">
          <div class="employee-row-name">${r.employee_name}</div>
          <div class="employee-row-meta">${r.last_checkup_date ? `最終受診: ${new Date(r.last_checkup_date).toLocaleDateString('ja-JP')}` : '未受診'}${r.next_due_date ? `・次回: ${new Date(r.next_due_date).toLocaleDateString('ja-JP')}` : ''}</div>
          <div class="employee-row-flags">
            ${r.is_overdue ? '<span class="mini-tag danger">期限超過</span>' : ''}
            ${r.needs_retest ? '<span class="mini-tag warn">再検査確認待ち</span>' : ''}
          </div>
        </div>
        <span style="color:var(--text-faint);">${icon('chevron-right')}</span>
      </div>
    `).join('');
    listEl.querySelectorAll('.employee-row').forEach((el) => {
      el.addEventListener('click', () => openEmployeeDetail(el.dataset.code, 'qual'));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doSaveAdminHealthRecord() {
  const session = getSession();
  const date = document.getElementById('health-admin-date').value;
  hideError('health-admin-error');
  if (!date) { showError('health-admin-error', '受診日を入力してください。'); return; }
  const btn = document.getElementById('health-admin-submit');
  btn.disabled = true;
  try {
    await rpc('admin_record_health_checkup', {
      p_admin_employee_code: session.employeeCode, p_target_employee_code: currentEmployeeDetailCode,
      p_checkup_date: date, p_checkup_type: document.getElementById('health-admin-type').value.trim() || null,
      p_institution: document.getElementById('health-admin-institution').value.trim() || null,
      p_next_due_date: document.getElementById('health-admin-next').value || null,
      p_result_confirmed: document.getElementById('health-admin-confirmed').checked,
      p_needs_retest: document.getElementById('health-admin-retest').checked,
      p_note: document.getElementById('health-admin-note').value.trim() || null,
    });
    showScreen('employee-detail');
    await loadEmployeeDetailQual();
  } catch (e) {
    showError('health-admin-error', e.message || '保存に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 日報(社員) ----------
// 社員が人工を直接入力することは一切ない。現場と勤務区分(終日/午前/午後)を選ぶと、
// 人工(終日=1.0・午前後=各0.5)は画面表示・送信ともにJS側で自動計算する。
// 通常は1〜2現場まで(2現場の場合は午前+午後の組み合わせのみ)。3現場以上は入力自体は
// 止めず「特殊日報」として送信できるが、通常のスプレッドシート反映対象からは外れ、
// 管理者確認キュー(daily-report-admin)へ回る。

const DR_HEADCOUNT_BY_WORK_TYPE = { '終日': 1.0, '午前': 0.5, '午後': 0.5 };
let dailyReportEntrySeq = 0;
// 代理入力の対象(本人以外の社員、または外注作業員)。self以外はnippo_admin/executiveのみ選べる。
let dailyReportTarget = { type: 'self', employeeCode: null, employeeName: null, subcontractorWorkerId: null, workerName: null };
let dailyReportIsNippoAdmin = false;

function addDailyReportEntry(prefill) {
  const template = document.getElementById('daily-report-entry-template');
  const clone = template.content.cloneNode(true);
  hydrateIcons(clone);
  const entryId = `dr-entry-${++dailyReportEntrySeq}`;
  const wrap = clone.querySelector('.daily-report-entry');
  wrap.dataset.entryId = entryId;

  const siteSelect = clone.querySelector('.dr-site-select');
  const siteSearch = clone.querySelector('.dr-site-search');
  const newSiteWrap = clone.querySelector('.dr-new-site-wrap');
  const newSiteToggleBtn = clone.querySelector('.dr-new-site-toggle-btn');
  populateSiteSelect(siteSelect, '').then(() => {
    if (prefill && prefill.site_id) siteSelect.value = String(prefill.site_id);
  });
  siteSearch.addEventListener('input', () => populateSiteSelect(siteSelect, siteSearch.value.trim()));
  siteSelect.addEventListener('change', () => {
    if (siteSelect.value === '__new__') newSiteWrap.style.display = 'block';
  });
  newSiteToggleBtn.addEventListener('click', () => {
    siteSelect.value = '__new__';
    newSiteWrap.style.display = 'block';
    wrap.querySelector('.dr-new-site-name').focus();
  });

  const workTypeSelect = clone.querySelector('.dr-work-type');
  if (prefill && prefill.work_type) workTypeSelect.value = prefill.work_type;
  workTypeSelect.addEventListener('change', updateDailyReportTotal);
  if (prefill && prefill.is_leader) clone.querySelector('.dr-is-leader').checked = true;
  if (prefill && prefill.is_night_shift) clone.querySelector('.dr-is-night-shift').checked = true;

  clone.querySelector('.dr-remove-entry-btn').addEventListener('click', () => {
    document.querySelector(`[data-entry-id="${entryId}"]`).remove();
    updateDailyReportTotal();
  });

  document.getElementById('daily-report-entry-list').appendChild(clone);
  updateDailyReportTotal();
}

// ワンタップで現場を差し込む(昨日と同じ現場・よく使う現場)。空の入力欄が無ければ1件追加してから入れる。
function applyRecentSiteToEntry(siteId, siteName) {
  let entryEls = Array.from(document.querySelectorAll('.daily-report-entry'));
  let target = entryEls.find((el) => !el.querySelector('.dr-site-select').value);
  if (!target) {
    if (entryEls.length >= 2) return; // 通常は最大2現場
    addDailyReportEntry();
    entryEls = Array.from(document.querySelectorAll('.daily-report-entry'));
    target = entryEls[entryEls.length - 1];
  }
  const select = target.querySelector('.dr-site-select');
  populateSiteSelect(select, siteName).then(() => { select.value = String(siteId); });
}

async function loadDailyReportRecentSites() {
  const area = document.getElementById('daily-report-recent-sites');
  const row = document.getElementById('daily-report-recent-sites-row');
  const params = dailyReportTarget.type === 'subcontractor'
    ? { p_employee_code: null, p_worker_type: 'subcontractor', p_subcontractor_worker_id: dailyReportTarget.subcontractorWorkerId }
    : { p_employee_code: dailyReportTarget.type === 'employee' ? dailyReportTarget.employeeCode : getSession().employeeCode, p_worker_type: 'employee', p_subcontractor_worker_id: null };
  if (dailyReportTarget.type === 'subcontractor' && !dailyReportTarget.subcontractorWorkerId) { area.style.display = 'none'; return; }
  try {
    const rows = await rpc('get_recent_daily_report_sites', params);
    if (!rows || rows.length === 0) { area.style.display = 'none'; return; }
    area.style.display = 'block';
    row.innerHTML = rows.map((r) => `
      <button type="button" class="filter-chip dr-recent-site-chip" data-site-id="${r.site_id}" data-site-name="${r.site_name}">${r.is_yesterday ? '昨日: ' : ''}${r.site_name}</button>
    `).join('');
    row.querySelectorAll('.dr-recent-site-chip').forEach((btn) => {
      btn.addEventListener('click', () => applyRecentSiteToEntry(btn.dataset.siteId, btn.dataset.siteName));
    });
  } catch (e) { area.style.display = 'none'; }
}

function updateDailyReportTotal() {
  const entries = document.querySelectorAll('.daily-report-entry');
  let total = 0;
  entries.forEach((el) => { total += DR_HEADCOUNT_BY_WORK_TYPE[el.querySelector('.dr-work-type').value] || 0; });
  document.getElementById('daily-report-total-headcount').textContent = total.toFixed(1);
  document.getElementById('daily-report-special-warning').style.display = entries.length >= 3 ? 'block' : 'none';
}

// 代理入力の対象に応じてget_my_daily_report_for_date相当のデータを取る。
// 本人以外はadmin_search_daily_reportsで代用する(1日分だけに絞り込む)。
async function fetchDailyReportForTarget(dateStr) {
  const session = getSession();
  if (dailyReportTarget.type === 'self') {
    return rpc('get_my_daily_report_for_date', { p_employee_code: session.employeeCode, p_report_date: dateStr });
  }
  const rows = await rpc('admin_search_daily_reports', {
    p_admin_employee_code: session.employeeCode, p_date_from: dateStr, p_date_to: dateStr,
    p_employee_code: dailyReportTarget.type === 'employee' ? dailyReportTarget.employeeCode : null,
    p_site_id: null, p_validation_status: null,
    p_worker_type: dailyReportTarget.type === 'subcontractor' ? 'subcontractor' : 'employee',
    p_subcontractor_company_id: null, p_report_status: null,
  });
  const filtered = dailyReportTarget.type === 'subcontractor'
    ? rows.filter((r) => r.subcontractor_worker_name === dailyReportTarget.workerName)
    : rows;
  return filtered.map((r) => ({
    site_id: r.site_id, work_type: r.work_type, reflected: !!r.reflected_to_sheet_at,
    report_status: r.report_status, is_leader: r.is_leader, is_night_shift: false,
  }));
}

async function loadDailyReportForDate(dateStr) {
  const hint = document.getElementById('daily-report-existing-hint');
  const submitBtn = document.getElementById('daily-report-submit');
  const addBtn = document.getElementById('daily-report-add-entry');
  hint.style.display = 'none';
  submitBtn.disabled = false;
  addBtn.disabled = false;
  document.getElementById('daily-report-entry-list').innerHTML = '';
  dailyReportEntrySeq = 0;
  loadDailyReportRecentSites();

  let existing = [];
  try {
    existing = await fetchDailyReportForTarget(dateStr);
  } catch (e) { /* 取得できなくても新規入力は続けられる */ }

  if (existing.length > 0) {
    const reflected = existing[0].reflected;
    hint.style.display = 'block';
    if (reflected) {
      hint.textContent = 'この日の日報は既にスプレッドシートへ反映済みです。内容を修正すると再反映されます。';
    } else {
      hint.textContent = 'この日は入力済みです。内容を修正して「日報を提出する」を押すと上書きされます。';
    }
    existing.forEach((e) => addDailyReportEntry({ site_id: e.site_id, work_type: e.work_type, is_leader: e.is_leader, is_night_shift: e.is_night_shift }));
  } else {
    addDailyReportEntry();
  }
}

async function resetDailyReportForm() {
  hideError('daily-report-error');
  const session = getSession();
  dailyReportTarget = { type: 'self', employeeCode: session.employeeCode, employeeName: session.employeeName, subcontractorWorkerId: null, workerName: null };
  document.getElementById('daily-report-target-type').value = 'self';
  document.getElementById('daily-report-target-employee-wrap').style.display = 'none';
  document.getElementById('daily-report-target-worker-wrap').style.display = 'none';

  try {
    dailyReportIsNippoAdmin = await rpc('check_nippo_admin', { p_employee_code: session.employeeCode });
  } catch (e) { dailyReportIsNippoAdmin = false; }
  document.getElementById('daily-report-proxy-wrap').style.display = dailyReportIsNippoAdmin ? 'block' : 'none';

  const dateInput = document.getElementById('daily-report-date');
  const today = todayJST();
  dateInput.value = today;
  loadDailyReportForDate(today);
}

async function doSubmitDailyReport(isDraft) {
  const session = getSession();
  hideError('daily-report-error');
  const dateStr = document.getElementById('daily-report-date').value;
  if (!dateStr) { showError('daily-report-error', '日付を選択してください。'); return; }

  if (dailyReportTarget.type === 'employee' && !dailyReportTarget.employeeCode) { showError('daily-report-error', '代理入力する社員を選択してください。'); return; }
  if (dailyReportTarget.type === 'subcontractor' && !dailyReportTarget.subcontractorWorkerId) { showError('daily-report-error', '外注作業員を選択してください。'); return; }

  const entryEls = Array.from(document.querySelectorAll('.daily-report-entry'));
  if (entryEls.length === 0) { showError('daily-report-error', '現場を1件以上入力してください。'); return; }

  const entries = [];
  for (const el of entryEls) {
    const siteSelect = el.querySelector('.dr-site-select');
    let siteId = siteSelect.value || null;
    let newSiteName = null;
    if (siteId === '__new__') {
      newSiteName = el.querySelector('.dr-new-site-name').value.trim();
      if (!newSiteName) { showError('daily-report-error', '新しい現場名を入力してください。'); return; }
      siteId = null;
    } else if (!siteId) {
      showError('daily-report-error', '現場を選択してください。'); return;
    }
    entries.push({
      site_id: siteId, new_site_name: newSiteName, work_type: el.querySelector('.dr-work-type').value,
      is_leader: el.querySelector('.dr-is-leader').checked, is_night_shift: el.querySelector('.dr-is-night-shift').checked,
    });
  }

  const btn = document.getElementById('daily-report-submit');
  btn.disabled = true;
  try {
    const result = await rpc('submit_daily_report', {
      p_actor_employee_code: session.employeeCode, p_report_date: dateStr, p_entries: entries, p_is_draft: !!isDraft,
      p_target_employee_code: dailyReportTarget.type === 'employee' ? dailyReportTarget.employeeCode : null,
      p_target_worker_type: dailyReportTarget.type === 'subcontractor' ? 'subcontractor' : 'employee',
      p_target_subcontractor_worker_id: dailyReportTarget.type === 'subcontractor' ? dailyReportTarget.subcontractorWorkerId : null,
    });
    const r = result && result[0];
    if (isDraft) { showDone(`日報を下書き保存しました(${dateStr})。提出は完了していません。`, 'menu-apply'); return; }
    const msg = r && r.is_special
      ? `日報を受け付けました(${dateStr}、${r.entry_count}現場)。3現場以上のため特殊日報として管理者が確認します。`
      : `日報を受け付けました(${dateStr}、合計${r ? Number(r.total_headcount).toFixed(1) : ''}人工)。`;
    showDone(msg, 'menu-apply');
  } catch (e) {
    showError('daily-report-error', e.message || '送信に失敗しました。もう一度お試しください。');
  } finally {
    btn.disabled = false;
  }
}

async function loadMyDailyReports() {
  const session = getSession();
  const list = document.getElementById('my-daily-report-list');
  list.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_daily_reports', { p_employee_code: session.employeeCode, p_limit: 30 });
    if (rows.length === 0) { list.innerHTML = '<div class="empty-state">まだ日報がありません</div>'; return; }
    list.innerHTML = rows.map((r) => `
      <div class="history-item">
        <div class="row1"><span>${r.report_date}</span><span>${Number(r.total_headcount).toFixed(1)}人工</span></div>
        <div class="row2">${r.site_names.map((n, i) => `${n}(${r.work_types[i]})`).join('・')}</div>
        ${r.is_special ? '<span class="mini-tag warn">特殊日報(管理者確認中)</span>' : ''}
        ${r.reflected ? '<span class="mini-tag muted">シート反映済み</span>' : ''}
      </div>
    `).join('');
  } catch (e) {
    list.innerHTML = '<div class="empty-state">読み込みに失敗しました</div>';
  }
}

// ---------- 日報の特殊ケース確認(管理者) ----------

let dailyReportAdminStatus = 'open';
async function loadDailyReportAdminList() {
  const session = getSession();
  const list = document.getElementById('daily-report-admin-list');
  list.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_daily_report_exceptions', { p_status: dailyReportAdminStatus || null });
    if (rows.length === 0) { list.innerHTML = '<div class="empty-state">該当する日報はありません</div>'; return; }
    list.innerHTML = rows.map((r) => `
      <div class="history-item">
        <div class="row1"><span>${r.context.employee_name}</span><span>${r.context.report_date}</span></div>
        <div class="row2">${r.message}</div>
        ${r.status === 'open' ? `<button type="button" class="secondary" data-resolve-id="${r.id}">対応済みにする</button>` : `<span class="mini-tag muted">対応済み</span>`}
      </div>
    `).join('');
    list.querySelectorAll('[data-resolve-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await rpc('resolve_error', { p_id: Number(btn.dataset.resolveId), p_status: 'resolved', p_resolution: `${session.employeeName}が確認しスプレッドシートへ手動反映` });
          loadDailyReportAdminList();
        } catch (e) { btn.disabled = false; }
      });
    });
  } catch (e) {
    list.innerHTML = '<div class="empty-state">読み込みに失敗しました</div>';
  }
}

// ---------- 申請管理(管理者、全申請横断検索) ----------

let areqFilters = { type: '', status: '', name: '', dateFrom: '', dateTo: '', site: '', partner: '' };
let areqRows = [];
let areqSort = { col: 'requested_at', dir: 'desc' };

async function loadAdminAllRequests() {
  const session = getSession();
  const listEl = document.getElementById('areq-list');
  const countEl = document.getElementById('areq-count');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    areqRows = await rpc('admin_search_requests', {
      p_admin_employee_code: session.employeeCode,
      p_request_type: areqFilters.type || null,
      p_employee_code: null,
      p_employee_name: areqFilters.name || null,
      p_status_group: areqFilters.status || null,
      p_date_from: areqFilters.dateFrom || null,
      p_date_to: areqFilters.dateTo || null,
      p_site_name: areqFilters.site || null,
      p_partner_name: areqFilters.partner || null,
      p_keyword: null,
    });
    countEl.textContent = `${areqRows.length}件`;
    renderAreqAll();
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
    document.getElementById('areq-table-body').innerHTML = '';
  }
}

// スマホはカード一覧(#areq-list)、PC(768px以上)はCSSで表形式(#areq-table-wrap)に
// 切り替える。データ取得は共通(areqRows)で、並び替えもここで両方に反映する。
function renderAreqAll() {
  const sorted = sortAreqRows(areqRows);
  renderAreqCards(sorted);
  renderAreqTable(sorted);
}

function sortAreqRows(rows) {
  const { col, dir } = areqSort;
  if (!col) return rows;
  const sorted = rows.slice().sort((a, b) => {
    let av = a[col]; let bv = b[col];
    if (col === 'employee_name' || col === 'source_type' || col === 'site_name' || col === 'status' || col === 'status_group') {
      av = av || ''; bv = bv || '';
      return String(av).localeCompare(String(bv), 'ja');
    }
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (col === 'requested_at' || col === 'updated_at') { av = new Date(av).getTime(); bv = new Date(bv).getTime(); }
    return av > bv ? 1 : av < bv ? -1 : 0;
  });
  if (dir === 'desc') sorted.reverse();
  return sorted;
}

function renderAreqCards(rows) {
  const listEl = document.getElementById('areq-list');
  if (rows.length === 0) { listEl.innerHTML = '<div class="hint">該当する申請はありません。</div>'; return; }
  listEl.innerHTML = rows.map((r) => {
    const amountStr = r.amount != null ? `${Number(r.amount).toLocaleString()}円` : '';
    const statusClass = r.status_group === 'approved' ? 'done' : (r.status_group === 'rejected' ? 'rejected' : '');
    return `
      <div class="history-item" data-type="${r.source_type}" data-id="${r.source_id}">
        <div class="row1"><span>${r.employee_name}・${REQUEST_TYPE_LABEL[r.source_type] || r.source_type}</span><span>${amountStr}</span></div>
        <div class="row2">${new Date(r.requested_at).toLocaleDateString('ja-JP')}　${r.summary || ''}</div>
        <span class="status-badge ${statusClass}">${STATUS_GROUP_LABEL[r.status_group] || r.status}</span>
        ${r.requires_special_review ? '<span class="mini-tag danger">事前申請なし</span>' : ''}
      </div>
    `;
  }).join('');
  listEl.querySelectorAll('.history-item').forEach((el) => {
    el.addEventListener('click', () => openRequestDetail(el.dataset.type, el.dataset.id));
  });
}

function renderAreqTable(rows) {
  const bodyEl = document.getElementById('areq-table-body');
  document.querySelectorAll('#screen-admin-all-requests .areq-table th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === areqSort.col);
    th.classList.toggle('desc', th.dataset.sort === areqSort.col && areqSort.dir === 'desc');
  });
  if (rows.length === 0) { bodyEl.innerHTML = `<tr><td colspan="9"><div class="hint">該当する申請はありません。</div></td></tr>`; return; }
  bodyEl.innerHTML = rows.map((r) => {
    const amountStr = r.amount != null ? `${Number(r.amount).toLocaleString()}円` : '-';
    const statusClass = r.status_group === 'approved' ? 'done' : (r.status_group === 'rejected' ? 'rejected' : '');
    return `
      <tr data-type="${r.source_type}" data-id="${r.source_id}">
        <td>${r.employee_name}</td>
        <td>${REQUEST_TYPE_LABEL[r.source_type] || r.source_type}${r.requires_special_review ? ' <span class="mini-tag danger">事前申請なし</span>' : ''}</td>
        <td>${new Date(r.requested_at).toLocaleDateString('ja-JP')}</td>
        <td>${r.site_name || '-'}</td>
        <td>${amountStr}</td>
        <td>${STATUS_LABEL[r.status] || r.status}</td>
        <td><span class="status-badge ${statusClass}">${STATUS_GROUP_LABEL[r.status_group] || r.status_group}</span></td>
        <td>${r.updated_at ? new Date(r.updated_at).toLocaleString('ja-JP') : '-'}</td>
        <td><button type="button" class="areq-table-detail-btn">詳細</button></td>
      </tr>
    `;
  }).join('');
  bodyEl.querySelectorAll('tr').forEach((tr) => {
    tr.addEventListener('click', () => openRequestDetail(tr.dataset.type, tr.dataset.id));
  });
}

let currentRequestDetail = null;

async function openRequestDetail(sourceType, sourceId) {
  const session = getSession();
  currentRequestDetail = { sourceType, sourceId: Number(sourceId) };
  document.getElementById('rdetail-title').textContent = REQUEST_TYPE_LABEL[sourceType] || sourceType;
  document.getElementById('rdetail-fields').innerHTML = '<div class="hint">読み込み中...</div>';
  document.getElementById('rdetail-history').innerHTML = '';
  document.getElementById('rdetail-actions').innerHTML = '';
  hideError('rdetail-error');
  showScreen('request-detail');

  try {
    const rows = await rpc('admin_search_requests', {
      p_admin_employee_code: session.employeeCode, p_request_type: sourceType, p_employee_code: null, p_employee_name: null,
      p_status_group: null, p_date_from: null, p_date_to: null, p_site_name: null, p_partner_name: null, p_keyword: null,
    });
    const r = rows.find((x) => String(x.source_id) === String(sourceId));
    if (!r) { document.getElementById('rdetail-fields').innerHTML = '<div class="hint">見つかりませんでした。</div>'; return; }

    document.getElementById('rdetail-fields').innerHTML = [
      ['申請者', r.employee_name], ['申請日時', new Date(r.requested_at).toLocaleString('ja-JP')],
      ['対象日', r.target_date || '-'], ['現在のステータス', STATUS_GROUP_LABEL[r.status_group] || r.status],
      ['現場', r.site_name || '-'], ['取引先', r.partner_name || '-'], ['金額', r.amount != null ? `${Number(r.amount).toLocaleString()}円` : '-'],
      ['内容', r.summary || '-'],
    ].map(([label, value]) => `<div class="field-row"><span class="field-label">${label}</span><span class="field-value">${value}</span></div>`).join('');

    const targetTable = sourceType === 'entertainment_preapproval' ? 'entertainment_preapprovals'
      : sourceType === 'qualification' ? 'employee_qualifications' : 'employee_requests';
    const history = await rpc('admin_get_request_audit_log', { p_admin_employee_code: session.employeeCode, p_target_table: targetTable, p_target_id: Number(sourceId) }).catch(() => []);
    const historyEl = document.getElementById('rdetail-history');
    historyEl.innerHTML = history.length === 0 ? '<div class="hint">変更履歴はありません。</div>' : history.map((h) => `
      <div class="change-request-item"><div class="row1"><span>${h.action}</span></div><div class="row2">${h.actor_name}・${new Date(h.created_at).toLocaleString('ja-JP')}</div></div>
    `).join('');

    renderRequestDetailActions(sourceType, r);
  } catch (e) {
    document.getElementById('rdetail-fields').innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

function renderRequestDetailActions(sourceType, r) {
  const box = document.getElementById('rdetail-actions');
  if (['expense_reimbursement', 'paid_leave', 'meeting'].includes(sourceType)) {
    if (r.status_group !== 'pending') { box.innerHTML = '<div class="hint">この申請は既に処理済みです。</div>'; return; }
    box.innerHTML = `
      <button type="button" id="rdetail-approve">承認する</button>
      <button type="button" class="secondary" id="rdetail-needs-info">差し戻す(要修正)</button>
      <button type="button" class="secondary" id="rdetail-reject">却下する</button>
      <div id="rdetail-reason-box" style="display:none;">
        <label>理由<span class="required-mark">(必須)</span></label>
        <textarea id="rdetail-reason"></textarea>
        <button type="button" id="rdetail-reason-confirm">確定する</button>
      </div>
    `;
    document.getElementById('rdetail-approve').addEventListener('click', () => doRequestDetailDecide('approved', null));
    document.getElementById('rdetail-needs-info').addEventListener('click', () => { const box = document.getElementById('rdetail-reason-box'); box.dataset.action = 'needs_info'; revealReasonBox(box); });
    document.getElementById('rdetail-reject').addEventListener('click', () => { const box = document.getElementById('rdetail-reason-box'); box.dataset.action = 'rejected'; revealReasonBox(box); });
    document.getElementById('rdetail-reason-confirm').addEventListener('click', () => {
      const reason = document.getElementById('rdetail-reason').value.trim();
      if (!reason) { showError('rdetail-error', '理由を入力してください。'); return; }
      doRequestDetailDecide(document.getElementById('rdetail-reason-box').dataset.action, reason);
    });
  } else if (sourceType === 'supply_item') {
    if (r.status_group !== 'pending') { box.innerHTML = '<div class="hint">この申請は既に処理済みです。</div>'; return; }
    box.innerHTML = `
      <div class="hint" style="margin-bottom:10px;">承認(実際に支給品を渡す)は「支給品の記録・検索」画面から行ってください。</div>
      <button type="button" class="secondary" id="rdetail-supply-reject">却下する</button>
      <div id="rdetail-reason-box" style="display:none;">
        <label>却下理由<span class="required-mark">(必須)</span></label>
        <textarea id="rdetail-reason"></textarea>
        <button type="button" id="rdetail-reason-confirm">確定する</button>
      </div>
    `;
    document.getElementById('rdetail-supply-reject').addEventListener('click', () => { revealReasonBox(document.getElementById('rdetail-reason-box')); });
    document.getElementById('rdetail-reason-confirm').addEventListener('click', async () => {
      const reason = document.getElementById('rdetail-reason').value.trim();
      if (!reason) { showError('rdetail-error', '却下理由を入力してください。'); return; }
      const session = getSession();
      try {
        await rpc('admin_decide_supply_request', { p_admin_employee_code: session.employeeCode, p_request_id: currentRequestDetail.sourceId, p_rejection_reason: reason });
        showScreen('admin-all-requests');
      } catch (e) { showError('rdetail-error', e.message || '処理に失敗しました。'); }
    });
  } else if (sourceType === 'entertainment_preapproval') {
    if (r.status_group !== 'pending' && r.status_group !== 'special_review') { box.innerHTML = '<div class="hint">この申請は既に処理済みです。</div>'; return; }
    const special = r.status_group === 'special_review';
    box.innerHTML = `
      ${special ? `${icon('alert-triangle')}<div class="preapproval-warning">この接待は事前申請されていません。例外承認の理由を入力してください。</div>
        <label>例外承認の理由<span class="required-mark">(必須)</span></label>
        <textarea id="rdetail-ent-reason"></textarea>` : ''}
      <button type="button" id="rdetail-ent-approve">${special ? '例外承認する' : '承認する'}</button>
      <button type="button" class="secondary" id="rdetail-ent-reject">却下する</button>
    `;
    document.getElementById('rdetail-ent-approve').addEventListener('click', async () => {
      const session = getSession();
      const reasonEl = document.getElementById('rdetail-ent-reason');
      try {
        await rpc('admin_decide_entertainment_preapproval', { p_admin_employee_code: session.employeeCode, p_id: currentRequestDetail.sourceId, p_action: 'approved', p_exception_reason: reasonEl ? reasonEl.value.trim() : null });
        showScreen('admin-all-requests');
      } catch (e) { showError('rdetail-error', e.message || '処理に失敗しました。'); }
    });
    document.getElementById('rdetail-ent-reject').addEventListener('click', async () => {
      const session = getSession();
      try {
        await rpc('admin_decide_entertainment_preapproval', { p_admin_employee_code: session.employeeCode, p_id: currentRequestDetail.sourceId, p_action: 'rejected', p_exception_reason: null });
        showScreen('admin-all-requests');
      } catch (e) { showError('rdetail-error', e.message || '処理に失敗しました。'); }
    });
  } else if (sourceType === 'qualification') {
    box.innerHTML = `<button type="button" class="secondary" data-nav="qual-admin">資格・免許管理で確認する</button>`;
    box.querySelector('[data-nav]').addEventListener('click', () => showScreen('qual-admin'));
  } else {
    box.innerHTML = '<div class="hint">この種類の申請はここからは操作できません。</div>';
  }
}

async function doRequestDetailDecide(action, reason) {
  const session = getSession();
  hideError('rdetail-error');
  try {
    await rpc('admin_decide_request', { p_admin_employee_code: session.employeeCode, p_request_id: currentRequestDetail.sourceId, p_action: action, p_rejection_reason: reason });
    showScreen('admin-all-requests');
  } catch (e) {
    showError('rdetail-error', e.message || '処理に失敗しました。');
  }
}

// ---------- 管理者管理(追加・解除・変更履歴) ----------

let armAllEmployees = [];

async function loadAdminRoleManagement() {
  const session = getSession();
  await Promise.all([loadAdminRoleCurrentList(), loadAdminRoleHistory()]);
  try {
    armAllEmployees = await rpc('list_active_employees', { p_admin_employee_code: session.employeeCode });
  } catch (e) { /* 無視 */ }
  document.getElementById('arm-add-search').value = '';
  document.getElementById('arm-add-candidates').innerHTML = '';
  hideError('arm-error');
}

async function loadAdminRoleCurrentList() {
  const session = getSession();
  const listEl = document.getElementById('arm-current-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_admin_roles', { p_admin_employee_code: session.employeeCode });
    const renderRows = (items, roleType) => items.map((r) => `
      <div class="employee-row" data-code="${r.employee_code}" style="cursor:default;">
        <span class="employee-avatar">${r.employee_name.slice(0, 1)}</span>
        <div class="employee-row-body">
          <div class="employee-row-name">${r.employee_name}(${r.employee_code})</div>
          <div class="employee-row-meta">付与: ${r.granted_by}・${new Date(r.granted_at).toLocaleDateString('ja-JP')}</div>
        </div>
        <button type="button" class="reject-btn arm-revoke-btn" data-role-type="${roleType}" style="width:auto;margin:0;">解除</button>
      </div>
    `).join('');

    const general = rows.filter((r) => r.role_type === 'general_admin');
    listEl.innerHTML = general.length === 0 ? '<div class="hint">管理者がいません。</div>' : renderRows(general, 'general_admin');
    listEl.querySelectorAll('.arm-revoke-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => doRevokeAdminRole(e.target.closest('.employee-row').dataset.code, btn.dataset.roleType));
    });

    const nippoEl = document.getElementById('arm-nippo-list');
    const nippo = rows.filter((r) => r.role_type === 'nippo_admin');
    nippoEl.innerHTML = nippo.length === 0 ? '<div class="hint">日報担当はいません。</div>' : renderRows(nippo, 'nippo_admin');
    nippoEl.querySelectorAll('.arm-revoke-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => doRevokeAdminRole(e.target.closest('.employee-row').dataset.code, btn.dataset.roleType));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function loadAdminRoleHistory() {
  const session = getSession();
  const listEl = document.getElementById('arm-history-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_get_role_change_history', { p_admin_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">変更履歴はありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => {
      const d = r.detail || {};
      const label = r.action === 'admin_role_granted' ? '追加' : '解除';
      return `
        <div class="change-request-item">
          <div class="row1"><span>${d.target_employee_name || ''}を管理者${label}</span></div>
          <div class="row2">${r.actor_name}・${new Date(r.created_at).toLocaleString('ja-JP')}</div>
        </div>
      `;
    }).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

function renderAdminRoleCandidates(query) {
  const listEl = document.getElementById('arm-add-candidates');
  const q = (query || '').trim();
  if (!q) { listEl.innerHTML = ''; return; }
  const matches = armAllEmployees.filter((e) => e.employee_name.includes(q) || e.employee_code.includes(q)).slice(0, 8);
  listEl.innerHTML = matches.map((e) => `
    <button type="button" class="candidate-item" data-code="${e.employee_code}" data-name="${e.employee_name}">${e.employee_name}(${e.employee_code})</button>
  `).join('');
  listEl.querySelectorAll('.candidate-item').forEach((btn) => {
    btn.addEventListener('click', () => doGrantAdminRole(btn.dataset.code, btn.dataset.name));
  });
}

async function doGrantAdminRole(employeeCode, employeeName) {
  const session = getSession();
  hideError('arm-error');
  const roleType = document.getElementById('arm-role-type-select').value;
  const roleLabel = roleType === 'nippo_admin' ? '日報担当' : '全体管理者';
  if (!window.confirm(`${employeeName}(${employeeCode})を${roleLabel}に追加しますか?`)) return;
  try {
    await rpc('admin_grant_admin_role', { p_admin_employee_code: session.employeeCode, p_target_employee_code: employeeCode, p_role_type: roleType });
    document.getElementById('arm-add-search').value = '';
    document.getElementById('arm-add-candidates').innerHTML = '';
    await Promise.all([loadAdminRoleCurrentList(), loadAdminRoleHistory()]);
  } catch (e) {
    showError('arm-error', e.message || '追加に失敗しました。');
  }
}

async function doRevokeAdminRole(employeeCode, roleType) {
  const session = getSession();
  hideError('arm-error');
  if (!window.confirm(`社員番号${employeeCode}を解除しますか?`)) return;
  try {
    await rpc('admin_revoke_admin_role', { p_admin_employee_code: session.employeeCode, p_target_employee_code: employeeCode, p_role_type: roleType || 'general_admin' });
    await Promise.all([loadAdminRoleCurrentList(), loadAdminRoleHistory()]);
  } catch (e) {
    showError('arm-error', e.message || '解除に失敗しました。');
  }
}

// ---------- 日報管理(管理者/日報担当) ----------

let drmFilters = { name: '', workerType: '', status: '', dateFrom: '', dateTo: '', site: null, companyId: '' };
let drmRows = [];
let drmSelected = new Set(); // 選択中のグループキー(report_date|personKey)
let drmSort = { col: 'report_date', dir: 'desc' };

const DRM_STATUS_LABEL = { draft: '下書き', submitted: '提出済み', confirmed: '確認済み', rejected: '差し戻し' };

async function loadDailyReportManagement() {
  const session = getSession();
  drmFilters = { name: '', workerType: '', status: '', dateFrom: '', dateTo: '', site: null, companyId: '' };
  drmSelected.clear();
  document.getElementById('drm-search-name').value = '';
  document.getElementById('drm-search-site').value = '';
  document.getElementById('drm-selected-site-label').style.display = 'none';
  document.getElementById('drm-site-candidates').innerHTML = '';
  document.getElementById('drm-date-from').value = '';
  document.getElementById('drm-date-to').value = '';
  document.getElementById('drm-advanced').style.display = 'none';
  document.getElementById('drm-missing-today-list').style.display = 'none';
  document.getElementById('drm-missing-toggle').textContent = '未提出者を表示する';
  document.querySelectorAll('#drm-worker-type-filter .filter-chip').forEach((c, i) => c.classList.toggle('active', i === 0));
  document.querySelectorAll('#drm-status-filter .filter-chip').forEach((c, i) => c.classList.toggle('active', i === 0));

  const missingEl = document.getElementById('drm-missing-today-list');
  const bannerCount = document.getElementById('drm-missing-count');
  bannerCount.textContent = '本日の未提出 -';
  try {
    const missing = await rpc('admin_get_daily_report_missing', { p_admin_employee_code: session.employeeCode, p_date: todayJST() });
    bannerCount.textContent = `本日の未提出 ${missing.length}名`;
    missingEl.innerHTML = missing.length === 0
      ? '<div class="hint">本日は全員提出済みです。</div>'
      : missing.map((m) => `<span class="mini-tag danger" style="display:inline-block;margin:2px 4px 2px 0;">${m.employee_name}</span>`).join('');
  } catch (e) {
    missingEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }

  try {
    const companies = await rpc('admin_list_subcontractor_companies', { p_admin_employee_code: session.employeeCode, p_include_inactive: false });
    document.getElementById('drm-company-select').innerHTML = '<option value="">すべての外注会社</option>' + companies.map((c) => `<option value="${c.id}">${c.company_name}</option>`).join('');
  } catch (e) { /* 無視 */ }

  loadDrmSummary();
  loadDailyReportManagementList();
}

const DRM_SUMMARY_CARDS = [
  { key: 'submitted_count', label: '本日の提出' },
  { key: 'missing_count', label: '本日の未提出' },
  { key: 'pending_confirm_count', label: '確認待ち' },
  { key: 'rejected_count', label: '差し戻し' },
  { key: 'confirmed_count', label: '確認済み' },
];

async function loadDrmSummary() {
  const session = getSession();
  const grid = document.getElementById('drm-summary-grid');
  grid.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_get_daily_report_summary', { p_admin_employee_code: session.employeeCode, p_date: todayJST() });
    const d = rows && rows[0];
    grid.innerHTML = DRM_SUMMARY_CARDS.map((c) => {
      const count = d ? (d[c.key] || 0) : 0;
      return `
        <div class="dash-card">
          <span class="dash-card-top"><span class="dash-card-count ${count === 0 ? 'zero' : 'alert'}">${count}</span></span>
          <span class="dash-card-label">${c.label}</span>
        </div>
      `;
    }).join('');
  } catch (e) {
    grid.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

function drmGroupKey(r) {
  return `${r.report_date}|${r.worker_type}|${r.employee_code || r.subcontractor_worker_name}`;
}

async function loadDailyReportManagementList() {
  const session = getSession();
  const listEl = document.getElementById('drm-list');
  const countEl = document.getElementById('drm-count');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  document.getElementById('drm-table-body').innerHTML = '';
  try {
    drmRows = await rpc('admin_search_daily_reports', {
      p_admin_employee_code: session.employeeCode,
      p_date_from: drmFilters.dateFrom || null, p_date_to: drmFilters.dateTo || null,
      p_employee_code: null, p_site_id: drmFilters.site || null,
      p_validation_status: null,
      p_worker_type: drmFilters.workerType || null,
      p_subcontractor_company_id: drmFilters.companyId ? Number(drmFilters.companyId) : null,
      p_report_status: drmFilters.status || null,
    });
    if (drmFilters.name) {
      const q = drmFilters.name;
      drmRows = drmRows.filter((r) => (r.employee_name || '').includes(q) || (r.subcontractor_worker_name || '').includes(q));
    }
    countEl.textContent = `${drmRows.length}件`;
    renderDrmAll();
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

function drmGroupSortValue(g, col) {
  const f = g.first;
  if (col === 'person_name') return f.worker_type === 'subcontractor' ? (f.subcontractor_worker_name || '') : (f.employee_name || '');
  if (col === 'company_name') return f.subcontractor_company_name || '';
  return f[col];
}

function sortDrmGroups(groupList) {
  const { col, dir } = drmSort;
  if (!col) return groupList;
  const sorted = groupList.slice().sort((a, b) => {
    let av = drmGroupSortValue(a, col);
    let bv = drmGroupSortValue(b, col);
    if (col === 'worker_type' || col === 'person_name' || col === 'company_name' || col === 'report_status') {
      av = av || ''; bv = bv || '';
      return String(av).localeCompare(String(bv), 'ja');
    }
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (col === 'submitted_at') { av = new Date(av).getTime(); bv = new Date(bv).getTime(); }
    return av > bv ? 1 : av < bv ? -1 : 0;
  });
  if (dir === 'desc') sorted.reverse();
  return sorted;
}

function renderDrmAll() {
  // report_date + 対象者 でグループ化し、現場1/現場2を横に並べる(スプレッドシートの
  // 「1日=現場1行+現場2行」構造とも対応させやすいよう、スロット順に並べる)。
  const groups = new Map();
  drmRows.forEach((r) => {
    const key = drmGroupKey(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });
  let groupList = Array.from(groups.entries()).map(([key, rows]) => {
    rows.sort((a, b) => (a.entry_slot || 0) - (b.entry_slot || 0));
    return { key, rows, first: rows[0] };
  });
  groupList = sortDrmGroups(groupList);

  document.querySelectorAll('#screen-daily-report-management .areq-table th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === drmSort.col);
    th.classList.toggle('desc', th.dataset.sort === drmSort.col && drmSort.dir === 'desc');
  });

  const listEl = document.getElementById('drm-list');
  if (groupList.length === 0) { listEl.innerHTML = '<div class="hint">該当する日報はありません。</div>'; document.getElementById('drm-table-body').innerHTML = '<tr><td colspan="12"><div class="hint">該当する日報はありません。</div></td></tr>'; return; }

  listEl.innerHTML = groupList.map((g) => {
    const f = g.first;
    const personName = f.worker_type === 'subcontractor' ? `${f.subcontractor_worker_name}(外注:${f.subcontractor_company_name || ''})` : (f.employee_name || '(不明)');
    const sites = g.rows.map((r) => `${r.site_name || '(現場不明)'}・${r.work_type || ''}`).join(' / ');
    const statusBadgeClass = f.report_status === 'confirmed' ? 'done' : (f.report_status === 'rejected' ? 'rejected' : '');
    return `
      <div class="history-item" data-key="${g.key}">
        <div class="row1"><span>${personName}</span><span>${f.report_date}</span></div>
        <div class="row2">${sites}</div>
        <span class="status-badge ${statusBadgeClass}">${DRM_STATUS_LABEL[f.report_status] || f.report_status}</span>
        ${f.validation_status === 'anomaly' ? '<span class="mini-tag danger">要確認</span>' : ''}
        ${g.rows.some((r) => r.reflect_override_work_type) ? '<span class="mini-tag info">反映値を調整済み</span>' : ''}
        ${g.rows.every((r) => r.reflected_to_sheet_at) ? '<span class="mini-tag info">シート反映済み</span>' : ''}
        <div class="checkbox-row"><input type="checkbox" class="drm-row-check" data-key="${g.key}" ${drmSelected.has(g.key) ? 'checked' : ''}><label>選択</label></div>
      </div>
    `;
  }).join('');
  listEl.querySelectorAll('.drm-row-check').forEach((cb) => {
    cb.addEventListener('change', () => { toggleDrmSelect(cb.dataset.key, cb.checked); });
  });
  listEl.querySelectorAll('.history-item').forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('drm-row-check') || ev.target.tagName === 'LABEL') return;
      openDailyReportDetail(el.dataset.key);
    });
  });

  const bodyEl = document.getElementById('drm-table-body');
  bodyEl.innerHTML = groupList.map((g) => {
    const f = g.first;
    const site1 = g.rows[0] || {};
    const site2 = g.rows[1] || {};
    const personName = f.worker_type === 'subcontractor' ? f.subcontractor_worker_name : f.employee_name;
    const statusBadgeClass = f.report_status === 'confirmed' ? 'done' : (f.report_status === 'rejected' ? 'rejected' : '');
    const reflected = g.rows.every((r) => r.reflected_to_sheet_at);
    return `
      <tr data-key="${g.key}">
        <td><input type="checkbox" class="drm-row-check" data-key="${g.key}" ${drmSelected.has(g.key) ? 'checked' : ''}></td>
        <td>${f.report_date}</td>
        <td>${f.worker_type === 'subcontractor' ? '外注' : '社員'}</td>
        <td>${personName || '(不明)'}</td>
        <td>${f.subcontractor_company_name || '-'}</td>
        <td>${site1.site_name || '-'}</td>
        <td>${site1.work_type || '-'}</td>
        <td>${site2.site_name ? `${site2.site_name}(${site2.work_type || ''})` : '-'}</td>
        <td>${f.submitted_at ? new Date(f.submitted_at).toLocaleString('ja-JP') : '-'}</td>
        <td>${DRM_STATUS_LABEL[f.report_status] || f.report_status}${g.rows.some((r) => r.reflect_override_work_type) ? ' <span class="mini-tag info">調整済み</span>' : ''}</td>
        <td><span class="status-badge ${statusBadgeClass}">${f.confirmed_by ? f.confirmed_by : (f.report_status === 'confirmed' || f.report_status === 'rejected' ? '-' : '未確認')}</span></td>
        <td>${reflected ? '反映済み' : '未反映'}</td>
      </tr>
    `;
  }).join('');
  bodyEl.querySelectorAll('.drm-row-check').forEach((cb) => {
    cb.addEventListener('change', () => { toggleDrmSelect(cb.dataset.key, cb.checked); });
  });
  bodyEl.querySelectorAll('tr[data-key]').forEach((tr) => {
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('drm-row-check')) return;
      openDailyReportDetail(tr.dataset.key);
    });
  });

  updateDrmBulkBar();
}

// 日報1件(グループ=同一日・同一対象者の現場1/2スロット)の詳細画面。
// 「原本(本人が提出した内容)」は表示専用、「スプレッドシートへ反映する内容」は
// 管理者が調整できる(reflect_override_*)。既にloadDailyReportManagementListで
// 取得済みのdrmRowsから該当グループを探すだけで、追加のRPC呼び出しは不要。
async function openDailyReportDetail(groupKey) {
  const rows = drmRows.filter((r) => drmGroupKey(r) === groupKey).sort((a, b) => (a.entry_slot || 0) - (b.entry_slot || 0));
  showScreen('daily-report-detail');
  if (rows.length === 0) {
    document.getElementById('drd-title').textContent = '日報詳細';
    document.getElementById('drd-meta').textContent = '該当する日報が見つかりませんでした。';
    document.getElementById('drd-slots').innerHTML = '';
    document.getElementById('drd-history').innerHTML = '';
    return;
  }
  const f = rows[0];
  const personName = f.worker_type === 'subcontractor' ? `${f.subcontractor_worker_name}(外注:${f.subcontractor_company_name || ''})` : (f.employee_name || '(不明)');
  document.getElementById('drd-title').textContent = `${personName}・${f.report_date}`;
  document.getElementById('drd-meta').textContent = `提出状況: ${DRM_STATUS_LABEL[f.report_status] || f.report_status}`;

  document.getElementById('drd-slots').innerHTML = rows.map((r, idx) => {
    const effWorkType = r.reflect_override_work_type || r.work_type;
    const effLeader = r.reflect_override_work_type ? r.reflect_override_is_leader : r.is_leader;
    const effNight = r.reflect_override_work_type ? r.reflect_override_is_night_shift : r.is_night_shift;
    return `
      <div class="card" data-slot-id="${r.id}">
        <div class="form-title" style="font-size:15px;">現場${idx + 1}(スロット${r.entry_slot || idx + 1})</div>
        <div class="field-group">
          <div class="field-row"><span class="field-label">【原本】現場</span><span class="field-value">${r.site_name || '-'}</span></div>
          <div class="field-row"><span class="field-label">【原本】勤務区分</span><span class="field-value">${r.work_type || '-'}${r.is_leader ? '・リーダー' : ''}${r.is_night_shift ? '・夜勤' : ''}</span></div>
          <div class="field-row"><span class="field-label">スプレッドシート反映</span><span class="field-value">${r.reflected_to_sheet_at ? `反映済み(${new Date(r.reflected_to_sheet_at).toLocaleString('ja-JP')})` : '未反映'}</span></div>
          ${r.reflect_override_work_type ? `<div class="field-row"><span class="field-label">反映値を調整</span><span class="field-value">${r.reflect_override_by || ''} ${r.reflect_override_at ? new Date(r.reflect_override_at).toLocaleString('ja-JP') : ''}${r.reflect_override_reason ? `(${r.reflect_override_reason})` : ''}</span></div>` : ''}
        </div>
        <div class="form-title" style="font-size:14px;">スプレッドシートへ反映する内容</div>
        <label>現場</label>
        <input type="text" class="drd-site-search" data-slot-id="${r.id}" placeholder="現場名で検索" value="${r.reflect_override_site_name || r.site_name || ''}">
        <input type="hidden" class="drd-site-id" data-slot-id="${r.id}" value="${r.reflect_override_site_id || r.site_id || ''}">
        <div class="drd-site-candidates" data-slot-id="${r.id}"></div>
        <label>勤務区分</label>
        <div class="filter-row drd-worktype" data-slot-id="${r.id}">
          <button type="button" class="filter-chip ${effWorkType === '終日' ? 'active' : ''}" data-work-type="終日">終日</button>
          <button type="button" class="filter-chip ${effWorkType === '午前' ? 'active' : ''}" data-work-type="午前">午前</button>
          <button type="button" class="filter-chip ${effWorkType === '午後' ? 'active' : ''}" data-work-type="午後">午後</button>
        </div>
        <label class="checkbox-row"><input type="checkbox" class="drd-leader" data-slot-id="${r.id}" ${effLeader ? 'checked' : ''}> リーダーとして参加</label>
        <label class="checkbox-row"><input type="checkbox" class="drd-night" data-slot-id="${r.id}" ${effNight ? 'checked' : ''}> 夜勤</label>
        <label>調整理由(任意)</label>
        <textarea class="drd-reason" data-slot-id="${r.id}"></textarea>
        <button type="button" class="drd-save" data-slot-id="${r.id}">保存(反映値を調整して再反映予約)</button>
        ${r.reflect_override_work_type ? `<button type="button" class="secondary drd-clear" data-slot-id="${r.id}">原本に戻す</button>` : ''}
        <div class="hint drd-result" data-slot-id="${r.id}"></div>
      </div>
    `;
  }).join('');

  wireDailyReportDetailSlots(rows);

  const historyEl = document.getElementById('drd-history');
  historyEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const session = getSession();
    const histories = await Promise.all(rows.map((r) => rpc('admin_get_daily_report_audit_log', { p_admin_employee_code: session.employeeCode, p_daily_report_id: r.id }).catch(() => [])));
    const merged = histories.flat().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    historyEl.innerHTML = merged.length === 0 ? '<div class="hint">変更履歴はありません。</div>' : merged.map((h) => `
      <div class="change-request-item"><div class="row1"><span>${h.action}</span></div><div class="row2">${h.actor_name}・${new Date(h.created_at).toLocaleString('ja-JP')}</div></div>
    `).join('');
  } catch (e) {
    historyEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

function wireDailyReportDetailSlots(rows) {
  const slotsEl = document.getElementById('drd-slots');
  slotsEl.querySelectorAll('.drd-worktype').forEach((row) => {
    row.querySelectorAll('.filter-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        row.querySelectorAll('.filter-chip').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  });

  let siteSearchTimer = null;
  slotsEl.querySelectorAll('.drd-site-search').forEach((input) => {
    input.addEventListener('input', () => {
      clearTimeout(siteSearchTimer);
      const slotId = input.dataset.slotId;
      const q = input.value.trim();
      const candEl = slotsEl.querySelector(`.drd-site-candidates[data-slot-id="${slotId}"]`);
      siteSearchTimer = setTimeout(async () => {
        if (!q) { candEl.innerHTML = ''; return; }
        const session = getSession();
        try {
          const sites = await rpc('admin_search_sites_simple', { p_admin_employee_code: session.employeeCode, p_query: q });
          candEl.innerHTML = sites.map((s) => `<button type="button" class="candidate-item" data-id="${s.id}" data-name="${s.site_name}">${s.site_name}</button>`).join('');
          candEl.querySelectorAll('.candidate-item').forEach((btn) => {
            btn.addEventListener('click', () => {
              input.value = btn.dataset.name;
              slotsEl.querySelector(`.drd-site-id[data-slot-id="${slotId}"]`).value = btn.dataset.id;
              candEl.innerHTML = '';
            });
          });
        } catch (e) { /* 無視 */ }
      }, 250);
    });
  });

  slotsEl.querySelectorAll('.drd-save').forEach((btn) => {
    btn.addEventListener('click', () => doSaveDailyReportReflectOverride(btn.dataset.slotId));
  });
  slotsEl.querySelectorAll('.drd-clear').forEach((btn) => {
    btn.addEventListener('click', () => doClearDailyReportReflectOverride(btn.dataset.slotId));
  });
}

async function doSaveDailyReportReflectOverride(slotId) {
  const session = getSession();
  const slotsEl = document.getElementById('drd-slots');
  const resultEl = slotsEl.querySelector(`.drd-result[data-slot-id="${slotId}"]`);
  const siteIdInput = slotsEl.querySelector(`.drd-site-id[data-slot-id="${slotId}"]`);
  const siteSearchInput = slotsEl.querySelector(`.drd-site-search[data-slot-id="${slotId}"]`);
  const workTypeBtn = slotsEl.querySelector(`.drd-worktype[data-slot-id="${slotId}"] .filter-chip.active`);
  const leader = slotsEl.querySelector(`.drd-leader[data-slot-id="${slotId}"]`).checked;
  const night = slotsEl.querySelector(`.drd-night[data-slot-id="${slotId}"]`).checked;
  const reason = slotsEl.querySelector(`.drd-reason[data-slot-id="${slotId}"]`).value.trim();
  if (!workTypeBtn) { resultEl.textContent = '勤務区分を選択してください。'; return; }
  const siteId = siteIdInput.value ? Number(siteIdInput.value) : null;
  const newSiteName = siteId ? null : siteSearchInput.value.trim();
  if (!siteId && !newSiteName) { resultEl.textContent = '現場を選択または入力してください。'; return; }
  resultEl.textContent = '保存中...';
  try {
    await rpc('admin_set_daily_report_reflect_override', {
      p_admin_employee_code: session.employeeCode, p_daily_report_id: Number(slotId),
      p_site_id: siteId, p_new_site_name: newSiteName, p_work_type: workTypeBtn.dataset.workType,
      p_is_leader: leader, p_is_night_shift: night, p_reason: reason || null,
    });
    resultEl.textContent = '保存しました(次回のスプレッドシート反映処理で更新されます)。';
    await loadDailyReportManagementList();
  } catch (e) {
    resultEl.textContent = e.message || '保存に失敗しました。';
  }
}

async function doClearDailyReportReflectOverride(slotId) {
  const session = getSession();
  const slotsEl = document.getElementById('drd-slots');
  const resultEl = slotsEl.querySelector(`.drd-result[data-slot-id="${slotId}"]`);
  resultEl.textContent = '処理中...';
  try {
    await rpc('admin_clear_daily_report_reflect_override', { p_admin_employee_code: session.employeeCode, p_daily_report_id: Number(slotId), p_reason: null });
    resultEl.textContent = '原本に戻しました(次回のスプレッドシート反映処理で更新されます)。';
    await loadDailyReportManagementList();
    const g = drmRows.find((r) => String(r.id) === String(slotId));
    if (g) openDailyReportDetail(drmGroupKey(g));
  } catch (e) {
    resultEl.textContent = e.message || '処理に失敗しました。';
  }
}

function toggleDrmSelect(key, checked) {
  if (checked) drmSelected.add(key); else drmSelected.delete(key);
  document.querySelectorAll(`.drm-row-check[data-key="${key}"]`).forEach((cb) => { cb.checked = checked; });
  updateDrmBulkBar();
}

function updateDrmBulkBar() {
  const bar = document.getElementById('drm-bulk-bar');
  bar.style.display = drmSelected.size > 0 ? 'block' : 'none';
  document.getElementById('drm-selected-count').textContent = `${drmSelected.size}件を選択中`;
  document.getElementById('drm-bulk-reason-box').style.display = 'none';
}

function drmSelectedRowIds() {
  const ids = [];
  drmSelected.forEach((key) => {
    drmRows.filter((r) => drmGroupKey(r) === key).forEach((r) => ids.push(Number(r.id)));
  });
  return ids;
}

async function doDrmBulkConfirm(action, reason) {
  const session = getSession();
  const ids = drmSelectedRowIds();
  if (ids.length === 0) return;
  try {
    await rpc('admin_confirm_daily_reports', { p_admin_employee_code: session.employeeCode, p_daily_report_ids: ids, p_action: action, p_reason: reason || null });
    drmSelected.clear();
    await loadDailyReportManagementList();
  } catch (e) {
    window.alert(e.message || '処理に失敗しました。');
  }
}

// ---------- 外注会社・外注作業員マスター管理(管理者/日報担当) ----------

async function loadSubcontractorCompanyAdmin() {
  const session = getSession();
  const listEl = document.getElementById('sc-company-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  document.getElementById('sc-company-edit-id').value = '';
  document.getElementById('sc-company-name').value = '';
  document.getElementById('sc-company-notes').value = '';
  hideError('sc-company-error');
  try {
    const rows = await rpc('admin_list_subcontractor_companies', { p_admin_employee_code: session.employeeCode, p_include_inactive: true });
    listEl.innerHTML = rows.map((c) => `
      <div class="supply-item" data-id="${c.id}" style="${c.status === 'active' ? '' : 'opacity:.5;'}">
        <div class="row1"><span>${c.company_name}</span><span>${c.worker_count}名</span></div>
        <div class="row2">${c.notes || ''}</div>
        <div class="qual-verify-btns">
          <button type="button" class="edit-sc-company-btn" data-name="${c.company_name}" data-notes="${c.notes || ''}">編集</button>
          <button type="button" class="reject-btn toggle-sc-company-btn" data-active="${c.status === 'active'}">${c.status === 'active' ? '停止する' : '再開する'}</button>
        </div>
      </div>
    `).join('');
    listEl.querySelectorAll('.edit-sc-company-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = btn.closest('.supply-item');
        document.getElementById('sc-company-edit-id').value = item.dataset.id;
        document.getElementById('sc-company-name').value = btn.dataset.name;
        document.getElementById('sc-company-notes').value = btn.dataset.notes;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
    listEl.querySelectorAll('.toggle-sc-company-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = btn.closest('.supply-item');
        await rpc('admin_set_subcontractor_company_active', { p_admin_employee_code: session.employeeCode, p_id: Number(item.dataset.id), p_active: btn.dataset.active !== 'true' });
        loadSubcontractorCompanyAdmin();
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doSaveSubcontractorCompany() {
  const session = getSession();
  const id = document.getElementById('sc-company-edit-id').value;
  const name = document.getElementById('sc-company-name').value.trim();
  const notes = document.getElementById('sc-company-notes').value.trim();
  hideError('sc-company-error');
  if (!name) { showError('sc-company-error', '会社名を入力してください。'); return; }
  const btn = document.getElementById('sc-company-submit');
  btn.disabled = true;
  try {
    await rpc('admin_upsert_subcontractor_company', { p_admin_employee_code: session.employeeCode, p_id: id ? Number(id) : null, p_company_name: name, p_notes: notes || null });
    await loadSubcontractorCompanyAdmin();
  } catch (e) {
    showError('sc-company-error', e.message || '保存に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

async function loadSubcontractorWorkerAdmin() {
  const session = getSession();
  const listEl = document.getElementById('sc-worker-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  document.getElementById('sc-worker-edit-id').value = '';
  document.getElementById('sc-worker-name').value = '';
  document.getElementById('sc-worker-notes').value = '';
  hideError('sc-worker-error');
  try {
    const companies = await rpc('admin_list_subcontractor_companies', { p_admin_employee_code: session.employeeCode, p_include_inactive: false });
    document.getElementById('sc-worker-company-select').innerHTML = companies.map((c) => `<option value="${c.id}">${c.company_name}</option>`).join('');
    const rows = await rpc('admin_list_subcontractor_workers', { p_admin_employee_code: session.employeeCode, p_company_id: null, p_include_inactive: true });
    listEl.innerHTML = rows.map((w) => `
      <div class="supply-item" data-id="${w.id}" style="${w.status === 'active' ? '' : 'opacity:.5;'}">
        <div class="row1"><span>${w.worker_name}</span><span>${w.company_name}</span></div>
        <div class="row2">${w.notes || ''}</div>
        <div class="qual-verify-btns">
          <button type="button" class="edit-sc-worker-btn" data-name="${w.worker_name}" data-notes="${w.notes || ''}" data-company="${w.subcontractor_company_id}">編集</button>
          <button type="button" class="reject-btn toggle-sc-worker-btn" data-active="${w.status === 'active'}">${w.status === 'active' ? '停止する' : '再開する'}</button>
        </div>
      </div>
    `).join('');
    listEl.querySelectorAll('.edit-sc-worker-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = btn.closest('.supply-item');
        document.getElementById('sc-worker-edit-id').value = item.dataset.id;
        document.getElementById('sc-worker-name').value = btn.dataset.name;
        document.getElementById('sc-worker-notes').value = btn.dataset.notes;
        document.getElementById('sc-worker-company-select').value = btn.dataset.company;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
    listEl.querySelectorAll('.toggle-sc-worker-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = btn.closest('.supply-item');
        await rpc('admin_set_subcontractor_worker_active', { p_admin_employee_code: session.employeeCode, p_id: Number(item.dataset.id), p_active: btn.dataset.active !== 'true' });
        loadSubcontractorWorkerAdmin();
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doSaveSubcontractorWorker() {
  const session = getSession();
  const id = document.getElementById('sc-worker-edit-id').value;
  const companyId = document.getElementById('sc-worker-company-select').value;
  const name = document.getElementById('sc-worker-name').value.trim();
  const notes = document.getElementById('sc-worker-notes').value.trim();
  hideError('sc-worker-error');
  if (!name) { showError('sc-worker-error', '作業員名を入力してください。'); return; }
  if (!companyId) { showError('sc-worker-error', '外注会社を選択してください。'); return; }
  const btn = document.getElementById('sc-worker-submit');
  btn.disabled = true;
  try {
    await rpc('admin_upsert_subcontractor_worker', { p_admin_employee_code: session.employeeCode, p_id: id ? Number(id) : null, p_subcontractor_company_id: Number(companyId), p_worker_name: name, p_notes: notes || null });
    await loadSubcontractorWorkerAdmin();
  } catch (e) {
    showError('sc-worker-error', e.message || '保存に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 使用目的マスター管理(管理者) ----------

function resetPurposeForm() {
  document.getElementById('purpose-edit-id').value = '';
  document.getElementById('purpose-name').value = '';
  hideError('purpose-error');
}

async function loadPurposeAdminList() {
  const session = getSession();
  const listEl = document.getElementById('purpose-admin-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  resetPurposeForm();
  try {
    const rows = await rpc('admin_list_expense_purposes', { p_admin_employee_code: session.employeeCode });
    listEl.innerHTML = rows.map((p) => `
      <div class="supply-item" data-id="${p.id}" style="${p.is_active ? '' : 'opacity:.5;'}">
        <div class="row1"><span>${p.name}</span><span>${p.is_active ? '有効' : '無効'}</span></div>
        <div class="qual-verify-btns">
          <button type="button" class="edit-purpose-btn" data-name="${p.name}">編集</button>
          <button type="button" class="reject-btn toggle-purpose-btn" data-active="${p.is_active}">${p.is_active ? '無効化する' : '再開する'}</button>
        </div>
      </div>
    `).join('');
    listEl.querySelectorAll('.edit-purpose-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = btn.closest('.supply-item');
        document.getElementById('purpose-edit-id').value = item.dataset.id;
        document.getElementById('purpose-name').value = btn.dataset.name;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
    listEl.querySelectorAll('.toggle-purpose-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = btn.closest('.supply-item');
        await rpc('admin_set_expense_purpose_active', { p_admin_employee_code: session.employeeCode, p_id: Number(item.dataset.id), p_is_active: btn.dataset.active !== 'true' });
        loadPurposeAdminList();
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doSavePurpose() {
  const session = getSession();
  const id = document.getElementById('purpose-edit-id').value;
  const name = document.getElementById('purpose-name').value.trim();
  hideError('purpose-error');
  if (!name) { showError('purpose-error', '使用目的名を入力してください。'); return; }
  const btn = document.getElementById('purpose-submit');
  btn.disabled = true;
  try {
    await rpc('admin_upsert_expense_purpose', { p_admin_employee_code: session.employeeCode, p_id: id ? Number(id) : null, p_name: name });
    await loadPurposeAdminList();
  } catch (e) {
    showError('purpose-error', e.message || '保存に失敗しました。');
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
      const showPicker = document.getElementById('announce-target-select').checked;
      document.getElementById('announce-employee-picker').style.display = showPicker ? 'block' : 'none';
    });
  });
  document.getElementById('announce-employee-search').addEventListener('input', (e) => renderAnnounceEmployeeChecklist(e.target.value));
  document.getElementById('announce-attachment-input').addEventListener('change', (e) => handleAnnounceAttachment(e.target.files[0]));

  document.getElementById('qual-submit').addEventListener('click', doSubmitQualification);
  document.getElementById('qual-photo-input').addEventListener('change', (e) => handleQualFile(e.target.files[0], 'photo'));
  document.getElementById('qual-pdf-input').addEventListener('change', (e) => handleQualFile(e.target.files[0], 'pdf'));
  document.getElementById('qual-admin-filter').addEventListener('change', loadQualAdminList);
  document.getElementById('qual-category-qualification').addEventListener('click', () => setQualCategory('qualification'));
  document.getElementById('qual-category-license').addEventListener('click', () => setQualCategory('license'));
  document.querySelectorAll('#screen-qual-admin .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#screen-qual-admin .filter-chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      qualAdminCategoryFilter = btn.dataset.cat;
      loadQualAdminList();
    });
  });

  document.getElementById('health-submit').addEventListener('click', doSubmitHealthCheckup);
  document.getElementById('health-file-input').addEventListener('change', (e) => handleHealthFile(e.target.files[0]));
  document.getElementById('health-admin-submit').addEventListener('click', doSaveAdminHealthRecord);
  document.getElementById('employee-detail-record-health-btn').addEventListener('click', () => {
    ['health-admin-date', 'health-admin-type', 'health-admin-institution', 'health-admin-next', 'health-admin-note'].forEach((id) => { document.getElementById(id).value = ''; });
    document.getElementById('health-admin-confirmed').checked = false;
    document.getElementById('health-admin-retest').checked = false;
    hideError('health-admin-error');
    showScreen('health-admin-record');
  });
  document.querySelectorAll('#screen-health-admin .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#screen-health-admin .filter-chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      healthAdminFilter = btn.dataset.healthFilter;
      loadHealthAdminList();
    });
  });

  document.getElementById('ent-submit').addEventListener('click', doSubmitEntertainmentPreapproval);
  document.getElementById('ent-update-submit').addEventListener('click', doUpdateEntertainmentActuals);
  document.getElementById('entertainment-admin-filter').addEventListener('change', loadEntertainmentAdminList);

  document.getElementById('license-type-submit').addEventListener('click', doSaveLicenseType);
  document.getElementById('purpose-submit').addEventListener('click', doSavePurpose);

  document.getElementById('arm-add-search').addEventListener('input', (e) => renderAdminRoleCandidates(e.target.value));

  let drmSiteSearchTimer = null;
  document.getElementById('drm-search-site').addEventListener('input', (e) => {
    clearTimeout(drmSiteSearchTimer);
    const q = e.target.value.trim();
    drmSiteSearchTimer = setTimeout(async () => {
      const session = getSession();
      const candEl = document.getElementById('drm-site-candidates');
      if (!q) { candEl.innerHTML = ''; return; }
      try {
        const rows = await rpc('admin_search_sites_simple', { p_admin_employee_code: session.employeeCode, p_query: q });
        candEl.innerHTML = rows.map((s) => `<button type="button" class="candidate-item" data-id="${s.id}" data-name="${s.site_name}">${s.site_name}</button>`).join('');
        candEl.querySelectorAll('.candidate-item').forEach((btn) => {
          btn.addEventListener('click', () => {
            drmFilters.site = Number(btn.dataset.id);
            document.getElementById('drm-selected-site-label').style.display = 'block';
            document.getElementById('drm-selected-site-label').textContent = `絞り込み中: ${btn.dataset.name}(解除するには検索欄を空にして再検索)`;
            candEl.innerHTML = '';
            document.getElementById('drm-search-site').value = '';
            loadDailyReportManagementList();
          });
        });
      } catch (e2) { /* 無視 */ }
    }, 250);
  });
  let drmNameSearchTimer = null;
  document.getElementById('drm-search-name').addEventListener('input', (e) => {
    clearTimeout(drmNameSearchTimer);
    drmNameSearchTimer = setTimeout(() => { drmFilters.name = e.target.value.trim(); loadDailyReportManagementList(); }, 300);
  });
  document.getElementById('drm-company-select').addEventListener('change', (e) => {
    drmFilters.companyId = e.target.value;
    loadDailyReportManagementList();
  });
  ['drm-date-from', 'drm-date-to'].forEach((id) => {
    document.getElementById(id).addEventListener('change', () => {
      drmFilters.dateFrom = document.getElementById('drm-date-from').value;
      drmFilters.dateTo = document.getElementById('drm-date-to').value;
      loadDailyReportManagementList();
    });
  });
  document.getElementById('drm-toggle-advanced').addEventListener('click', () => {
    const el = document.getElementById('drm-advanced');
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('drm-missing-toggle').addEventListener('click', () => {
    const el = document.getElementById('drm-missing-today-list');
    const show = el.style.display === 'none';
    el.style.display = show ? 'block' : 'none';
    document.getElementById('drm-missing-toggle').textContent = show ? '未提出者を隠す' : '未提出者を表示する';
  });
  document.getElementById('drm-notify-btn').addEventListener('click', async () => {
    const session = getSession();
    const btn = document.getElementById('drm-notify-btn');
    btn.disabled = true;
    try {
      const count = await rpc('admin_notify_missing_daily_reports', { p_admin_employee_code: session.employeeCode, p_date: todayJST() });
      window.alert(`${count}名へ通知を送信しました。`);
    } catch (e) {
      window.alert(e.message || '通知の送信に失敗しました。');
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById('drm-autoconfirm-btn').addEventListener('click', async () => {
    const session = getSession();
    const btn = document.getElementById('drm-autoconfirm-btn');
    const resultEl = document.getElementById('drm-autoconfirm-result');
    btn.disabled = true;
    resultEl.textContent = '実行中...';
    try {
      const count = await rpc('admin_run_auto_confirm_sweep', { p_admin_employee_code: session.employeeCode, p_date: todayJST() });
      resultEl.textContent = `${count}件を自動確認しました。`;
      loadDrmSummary();
      loadDailyReportManagementList();
    } catch (e) {
      resultEl.textContent = e.message || '自動確認の実行に失敗しました。';
    } finally {
      btn.disabled = false;
    }
  });
  document.querySelectorAll('#screen-daily-report-management .areq-table th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      drmSort = { col, dir: drmSort.col === col && drmSort.dir === 'asc' ? 'desc' : 'asc' };
      renderDrmAll();
    });
  });
  document.querySelectorAll('#drm-worker-type-filter .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#drm-worker-type-filter .filter-chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      drmFilters.workerType = btn.dataset.workerType;
      loadDailyReportManagementList();
    });
  });
  document.querySelectorAll('#drm-status-filter .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#drm-status-filter .filter-chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      drmFilters.status = btn.dataset.status;
      loadDailyReportManagementList();
    });
  });
  document.getElementById('drm-select-all').addEventListener('change', (e) => {
    const groups = new Set(drmRows.map((r) => drmGroupKey(r)));
    if (e.target.checked) { groups.forEach((k) => drmSelected.add(k)); } else { drmSelected.clear(); }
    renderDrmAll();
  });
  document.getElementById('drm-bulk-confirm').addEventListener('click', () => doDrmBulkConfirm('confirmed', null));
  document.getElementById('drm-bulk-reject').addEventListener('click', () => { revealReasonBox(document.getElementById('drm-bulk-reason-box')); });
  document.getElementById('drm-bulk-reason-confirm').addEventListener('click', () => {
    const reason = document.getElementById('drm-bulk-reason').value.trim();
    if (!reason) return;
    doDrmBulkConfirm('rejected', reason);
  });

  document.getElementById('sc-company-submit').addEventListener('click', doSaveSubcontractorCompany);
  document.getElementById('sc-worker-submit').addEventListener('click', doSaveSubcontractorWorker);

  let areqSearchTimer = null;
  document.getElementById('areq-search-name').addEventListener('input', (e) => {
    clearTimeout(areqSearchTimer);
    areqSearchTimer = setTimeout(() => { areqFilters.name = e.target.value.trim(); loadAdminAllRequests(); }, 300);
  });
  document.querySelectorAll('#areq-type-filter .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#areq-type-filter .filter-chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      areqFilters.type = btn.dataset.type;
      loadAdminAllRequests();
    });
  });
  document.querySelectorAll('#areq-status-filter .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#areq-status-filter .filter-chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      areqFilters.status = btn.dataset.status;
      loadAdminAllRequests();
    });
  });
  document.getElementById('areq-toggle-advanced').addEventListener('click', () => {
    const el = document.getElementById('areq-advanced');
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  });
  ['areq-date-from', 'areq-date-to', 'areq-site', 'areq-partner'].forEach((id) => {
    document.getElementById(id).addEventListener('change', () => {
      areqFilters.dateFrom = document.getElementById('areq-date-from').value;
      areqFilters.dateTo = document.getElementById('areq-date-to').value;
      areqFilters.site = document.getElementById('areq-site').value.trim();
      areqFilters.partner = document.getElementById('areq-partner').value.trim();
      loadAdminAllRequests();
    });
  });
  // PC版のテーブル表示: 見出しクリックで並び替え(再取得はせずareqRowsをクライアント側で並び替え)
  document.querySelectorAll('#screen-admin-all-requests .areq-table th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      areqSort = { col, dir: areqSort.col === col && areqSort.dir === 'asc' ? 'desc' : 'asc' };
      renderAreqAll();
    });
  });

  document.getElementById('daily-report-date').addEventListener('change', (e) => loadDailyReportForDate(e.target.value));
  document.getElementById('daily-report-add-entry').addEventListener('click', () => addDailyReportEntry());
  document.getElementById('daily-report-add-special-entry').addEventListener('click', () => addDailyReportEntry());
  document.getElementById('daily-report-submit').addEventListener('click', () => doSubmitDailyReport(false));
  document.getElementById('daily-report-save-draft').addEventListener('click', () => doSubmitDailyReport(true));

  document.getElementById('daily-report-target-type').addEventListener('change', (e) => {
    const session = getSession();
    const type = e.target.value;
    document.getElementById('daily-report-target-employee-wrap').style.display = type === 'employee' ? 'block' : 'none';
    document.getElementById('daily-report-target-worker-wrap').style.display = type === 'subcontractor' ? 'block' : 'none';
    if (type === 'self') {
      dailyReportTarget = { type: 'self', employeeCode: session.employeeCode, employeeName: session.employeeName, subcontractorWorkerId: null, workerName: null };
      loadDailyReportForDate(document.getElementById('daily-report-date').value);
    } else {
      dailyReportTarget = { type, employeeCode: null, employeeName: null, subcontractorWorkerId: null, workerName: null };
    }
  });
  document.getElementById('daily-report-target-employee-search').addEventListener('input', async (e) => {
    const q = e.target.value.trim();
    const results = document.getElementById('daily-report-target-employee-results');
    if (q.length < 1) { results.innerHTML = ''; return; }
    const session = getSession();
    try {
      const rows = await rpc('list_employees_for_participant_select', { p_employee_code: session.employeeCode });
      const matches = rows.filter((r) => r.employee_name.includes(q) || r.employee_code.includes(q)).slice(0, 8);
      results.innerHTML = matches.map((r) => `<button type="button" class="candidate-item" data-code="${r.employee_code}" data-name="${r.employee_name}">${r.employee_name}(${r.employee_code})</button>`).join('');
      results.querySelectorAll('.candidate-item').forEach((btn) => {
        btn.addEventListener('click', () => {
          dailyReportTarget = { type: 'employee', employeeCode: btn.dataset.code, employeeName: btn.dataset.name, subcontractorWorkerId: null, workerName: null };
          document.getElementById('daily-report-target-employee-label').style.display = 'block';
          document.getElementById('daily-report-target-employee-label').textContent = `選択中: ${btn.dataset.name}(${btn.dataset.code})`;
          results.innerHTML = ''; e.target.value = '';
          loadDailyReportForDate(document.getElementById('daily-report-date').value);
        });
      });
    } catch (err) { /* 無視 */ }
  });
  document.getElementById('daily-report-target-worker-search').addEventListener('input', async (e) => {
    const q = e.target.value.trim();
    const results = document.getElementById('daily-report-target-worker-results');
    try {
      const rows = await rpc('search_subcontractor_workers', { p_query: q || null });
      results.innerHTML = rows.map((r) => `<button type="button" class="candidate-item" data-id="${r.id}" data-name="${r.worker_name}">${r.worker_name}(${r.company_name})</button>`).join('');
      results.querySelectorAll('.candidate-item').forEach((btn) => {
        btn.addEventListener('click', () => {
          dailyReportTarget = { type: 'subcontractor', employeeCode: null, employeeName: null, subcontractorWorkerId: Number(btn.dataset.id), workerName: btn.dataset.name };
          document.getElementById('daily-report-target-worker-label').style.display = 'block';
          document.getElementById('daily-report-target-worker-label').textContent = `選択中: ${btn.dataset.name}`;
          results.innerHTML = ''; e.target.value = '';
          loadDailyReportForDate(document.getElementById('daily-report-date').value);
        });
      });
    } catch (err) { /* 無視 */ }
  });
  document.querySelectorAll('#screen-daily-report-admin .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#screen-daily-report-admin .filter-chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      dailyReportAdminStatus = btn.dataset.status;
      loadDailyReportAdminList();
    });
  });

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
  SCREEN_ENTER_HOOKS['health-submit'] = resetHealthForm;
  SCREEN_ENTER_HOOKS['my-qual'] = () => { loadMyQualifications(); loadMyHealthSummary(); };
  SCREEN_ENTER_HOOKS['my-health'] = loadMyHealthList;
  SCREEN_ENTER_HOOKS['entertainment-submit'] = resetEntertainmentForm;
  SCREEN_ENTER_HOOKS['my-entertainment'] = loadMyEntertainmentList;
  SCREEN_ENTER_HOOKS['entertainment-admin'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadEntertainmentAdminList();
  };
  SCREEN_ENTER_HOOKS['site-admin'] = async () => {
    if (!(await isNippoAdmin())) { enterMenu(); return; }
    loadSiteAdminList();
  };
  document.getElementById('site-create-submit').addEventListener('click', doCreateSite);
  let siteListSearchTimer = null;
  document.getElementById('site-list-search').addEventListener('input', (e) => {
    clearTimeout(siteListSearchTimer);
    siteListSearchTimer = setTimeout(() => { siteListQuery = e.target.value.trim(); loadAllSitesList(); }, 300);
  });
  SCREEN_ENTER_HOOKS['license-admin'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadLicenseTypeAdminList();
  };
  SCREEN_ENTER_HOOKS['health-admin'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadHealthAdminList();
  };
  SCREEN_ENTER_HOOKS['daily-report'] = resetDailyReportForm;
  SCREEN_ENTER_HOOKS['my-daily-reports'] = loadMyDailyReports;
  SCREEN_ENTER_HOOKS['daily-report-admin'] = async () => {
    if (!(await isNippoAdmin())) { enterMenu(); return; }
    loadDailyReportAdminList();
  };
  SCREEN_ENTER_HOOKS['purpose-admin'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadPurposeAdminList();
  };
  SCREEN_ENTER_HOOKS['admin-all-requests'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadAdminAllRequests();
  };
  SCREEN_ENTER_HOOKS['admin-role-management'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadAdminRoleManagement();
  };
  SCREEN_ENTER_HOOKS['daily-report-management'] = async () => {
    if (!(await isNippoAdmin())) { enterMenu(); return; }
    loadDailyReportManagement();
  };
  SCREEN_ENTER_HOOKS['subcontractor-company-admin'] = async () => {
    if (!(await isNippoAdmin())) { enterMenu(); return; }
    loadSubcontractorCompanyAdmin();
  };
  SCREEN_ENTER_HOOKS['subcontractor-worker-admin'] = async () => {
    if (!(await isNippoAdmin())) { enterMenu(); return; }
    loadSubcontractorWorkerAdmin();
  };
  SCREEN_ENTER_HOOKS['daily-report-detail'] = async () => {
    if (!(await isNippoAdmin())) { enterMenu(); return; }
  };

  const session = getSession();
  if (session && session.employeeId) {
    enterMenu();
  } else {
    startLoginFlow();
  }

  // PWAをホーム画面に追加して使う実機では、アプリを開いたままだと新しいバージョンの
  // Service Workerが有効化されても画面上のHTML/JSは古いまま(再読み込みするまで反映されない)。
  // sw.js側でskipWaiting+clients.claim済みなので、制御が新しいSWへ切り替わった瞬間に
  // 自動で1回だけ再読み込みし、実機でも次に開いたときには必ず最新版になるようにする。
  if ('serviceWorker' in navigator) {
    let swRefreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (swRefreshing) return;
      swRefreshing = true;
      window.location.reload();
    });
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
