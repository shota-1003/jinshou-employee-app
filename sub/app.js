'use strict';
// 迅翔興業 外注本人ポータル。社員ポータル(employee-app)と同じ「ソースは本番URL固定、
// Staging/Productionへはコピー先で差し替える」方式。外注本人はログインID+暗証番号で認証し、
// 端末トークン(X-Sub-Device-Token)で以後のRPCを呼ぶ。9ステップ: ①初回登録 ②基本情報
// ③会社紐付け ④資格 ⑤現場 ⑥終日/午前/午後 ⑦人工 ⑧残業 ⑨登録。

const SUPABASE_URL = 'https://tcxbtanumtuyfrqtjtvo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_UVAjFJSjIs7Sl2tMpLWRkQ_uyDw9eyW';
// ↓ここはStaging/Productionのビルド差し替えマーカー(employee-appと同じ運用)。手で書き換えない。
const IS_STAGING = false; // BUILD_FLAG_IS_STAGING

const SUB_AUTH_KEY = 'jinshou_sub_auth'; // localStorage {loginCode, token}
let loginCode = null;
let deviceToken = null;
let currentWorker = null; // {name, company}

function loadAuth() {
  try { const a = JSON.parse(localStorage.getItem(SUB_AUTH_KEY) || 'null'); if (a && a.loginCode) { loginCode = a.loginCode; deviceToken = a.token || null; } } catch (e) {}
}
function saveAuth() { try { localStorage.setItem(SUB_AUTH_KEY, JSON.stringify({ loginCode, token: deviceToken })); } catch (e) {} }
function clearAuth() { try { localStorage.removeItem(SUB_AUTH_KEY); } catch (e) {} loginCode = null; deviceToken = null; currentWorker = null; }

async function rpc(name, params) {
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' };
  if (deviceToken) headers['X-Sub-Device-Token'] = deviceToken;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(params || {}) });
  const txt = await res.text();
  let body; try { body = JSON.parse(txt); } catch (e) { body = txt; }
  if (!res.ok) {
    const msg = (body && body.message) ? body.message : `通信に失敗しました (${res.status})`;
    const err = new Error(msg); err.status = res.status; err.code = body && body.code; throw err;
  }
  return body;
}

function $(id) { return document.getElementById(id); }
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  const el = $('screen-' + id);
  if (el) el.classList.add('active');
  window.scrollTo(0, 0);
}
function setErr(id, msg) { const el = $(id); if (el) { el.textContent = msg || ''; el.style.display = msg ? 'block' : 'none'; } }
function todayJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + (now.getTimezoneOffset() + 540) * 60000);
  return `${jst.getFullYear()}-${String(jst.getMonth() + 1).padStart(2, '0')}-${String(jst.getDate()).padStart(2, '0')}`;
}

// ---- 起動 ----
async function boot() {
  loadAuth();
  if (IS_STAGING) { const b = $('staging-banner'); if (b) b.style.display = 'block'; }
  bindEvents();
  if (loginCode && deviceToken) {
    // 端末トークンでセッション再開を試す
    try {
      const r = await rpc('subcontractor_resume_session', { p_login_code: loginCode });
      const row = Array.isArray(r) ? r[0] : r;
      if (row && row.out_worker_id) { currentWorker = { name: row.out_worker_name, company: row.out_company_name }; enterHome(); return; }
    } catch (e) { /* 期限切れ等 → 暗証番号ログインへ */ }
    // トークンが無効: IDは覚えているので暗証番号画面へ
    $('pin-entry-name').textContent = 'ログインID: ' + loginCode;
    showScreen('pin-entry');
    return;
  }
  showScreen('login');
}

function bindEvents() {
  // ① ログインID入力 → 初回か2回目かを判定できないので、まず初回コード画面へ誘導しつつ、
  //    実際はPINログインを試して失敗したら初回登録へ。ここではID確定のみ。
  $('login-btn').addEventListener('click', () => {
    const code = $('login-code').value.trim();
    if (!code) { setErr('login-error', 'ログインIDを入力してください。'); return; }
    setErr('login-error', '');
    loginCode = code;
    // 初回か既存かはサーバーにしか分からない。まずPINログイン画面を出し、
    // 「初回の方はこちら」で初回登録へ行ける導線にする。
    $('pin-entry-name').textContent = 'ログインID: ' + loginCode;
    $('pin-entry-switch').textContent = '初回の方 / 別のIDでログイン';
    showScreen('pin-entry');
  });

  // 暗証番号ログイン(2回目以降)
  $('pin-entry-submit').addEventListener('click', doPinLogin);
  $('pin-entry-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doPinLogin(); });
  $('pin-entry-switch').addEventListener('click', () => {
    // 初回登録 or 別ID。初回登録画面へ。
    $('first-login-name').textContent = 'ログインID: ' + (loginCode || '');
    showScreen('first-login');
  });

  // 初回登録
  $('first-login-submit').addEventListener('click', doFirstLogin);
  $('first-login-back').addEventListener('click', () => { showScreen('login'); });

  // ホーム
  $('home-attendance-btn').addEventListener('click', openAttendance);
  $('home-profile-btn').addEventListener('click', openProfile);
  $('home-logout-btn').addEventListener('click', doLogout);

  // もどる
  document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => showScreen(b.getAttribute('data-back'))));

  // プロフィール保存
  $('profile-save-btn').addEventListener('click', saveProfile);
  $('qual-add-btn').addEventListener('click', addQualification);
  $('health-add-btn').addEventListener('click', addHealthCheckup);

  // 勤務区分セグメント → 人工の自動セット
  document.querySelectorAll('#att-worktype .seg').forEach((seg) => seg.addEventListener('click', () => {
    document.querySelectorAll('#att-worktype .seg').forEach((s) => s.classList.remove('active'));
    seg.classList.add('active');
    const wt = seg.getAttribute('data-wt');
    $('att-headcount').value = (wt === '終日') ? '1' : '0.5';
  }));

  // 現場セレクトで「その他(手入力)」
  $('att-site').addEventListener('change', () => {
    $('att-newsite-wrap').style.display = ($('att-site').value === '__new__') ? 'block' : 'none';
  });

  $('att-submit-btn').addEventListener('click', submitAttendance);
  $('done-home-btn').addEventListener('click', enterHome);
}

async function doPinLogin() {
  const pin = $('pin-entry-code').value.trim();
  if (!pin) { setErr('pin-entry-error', '暗証番号を入力してください。'); return; }
  setErr('pin-entry-error', '');
  try {
    const r = await rpc('subcontractor_verify_pin', { p_login_code: loginCode, p_pin: pin });
    const row = Array.isArray(r) ? r[0] : r;
    if (!row || !row.out_device_token) throw new Error('ログインに失敗しました。');
    deviceToken = row.out_device_token;
    currentWorker = { name: row.out_worker_name, company: row.out_company_name };
    saveAuth();
    $('pin-entry-code').value = '';
    enterHome();
  } catch (e) {
    setErr('pin-entry-error', e.message || 'ログインに失敗しました。初回の方は下の「初回の方」からご登録ください。');
  }
}

async function doFirstLogin() {
  const code = $('first-code').value.trim();
  const pin = $('first-pin').value.trim();
  const pin2 = $('first-pin2').value.trim();
  if (!code) { setErr('first-login-error', '初回登録コードを入力してください。'); return; }
  if (!pin || pin.length < 4) { setErr('first-login-error', '暗証番号は4〜6桁で決めてください。'); return; }
  if (pin !== pin2) { setErr('first-login-error', '暗証番号(確認)が一致しません。'); return; }
  setErr('first-login-error', '');
  try {
    const r = await rpc('subcontractor_first_login', { p_login_code: loginCode, p_code: code, p_pin: pin });
    const row = Array.isArray(r) ? r[0] : r;
    if (!row || !row.out_device_token) throw new Error('初回登録に失敗しました。');
    deviceToken = row.out_device_token;
    currentWorker = { name: row.out_worker_name, company: row.out_company_name };
    saveAuth();
    $('first-code').value = ''; $('first-pin').value = ''; $('first-pin2').value = '';
    // 初回はプロフィール登録へ誘導
    enterHome();
    openProfile();
  } catch (e) {
    setErr('first-login-error', e.message || '初回登録に失敗しました。コードの有効期限や入力内容をご確認ください。');
  }
}

function doLogout() {
  rpc('subcontractor_logout', { p_login_code: loginCode }).catch(() => {});
  clearAuth();
  showScreen('login');
  $('login-code').value = '';
}

function enterHome() {
  $('home-worker-name').textContent = (currentWorker && currentWorker.name) || '';
  $('home-company-name').textContent = (currentWorker && currentWorker.company) ? '所属: ' + currentWorker.company : '';
  showScreen('home');
  loadRecent();
}

async function loadRecent() {
  try {
    const r = await rpc('get_my_subcontractor_attendance', { p_login_code: loginCode, p_report_date: todayJST() });
    const rows = r || [];
    if (rows.length) {
      $('home-recent-wrap').style.display = 'block';
      $('home-recent-list').innerHTML = rows.map((x) => `<div class="recent-item">${escapeHtml(x.site_name || '(現場未設定)')}｜${escapeHtml(x.work_type || '')}${x.reflected ? '<span class="chip">反映済</span>' : ''}</div>`).join('');
    } else { $('home-recent-wrap').style.display = 'none'; }
  } catch (e) { $('home-recent-wrap').style.display = 'none'; }
}

// ②③④ プロフィール
async function openProfile() {
  showScreen('profile');
  setErr('profile-error', '');
  try {
    const r = await rpc('get_my_subcontractor_profile', { p_login_code: loginCode });
    const p = Array.isArray(r) ? r[0] : r;
    if (!p) return;
    $('pf-name').value = p.worker_name || '';
    $('pf-furigana').value = p.furigana || '';
    $('pf-birth').value = p.birth_date || '';
    $('pf-phone').value = p.phone || '';
    $('pf-address').value = p.address || '';
    $('pf-blood').value = p.blood_type || '';
    $('pf-ec-name').value = p.emergency_contact_name || '';
    $('pf-ec-rel').value = p.emergency_contact_relation || '';
    $('pf-ec-phone').value = p.emergency_contact_phone || '';
    // ④⑤ 資格・健診(複数・専用マスター)
    await loadQualifications();
    await loadHealthCheckups();
    // ③ 会社
    if (p.company_locked) {
      $('pf-company-locked').style.display = 'block';
      $('pf-company-select-wrap').style.display = 'none';
      $('pf-company-name').textContent = p.company_name || '(未設定)';
    } else {
      $('pf-company-locked').style.display = 'none';
      $('pf-company-select-wrap').style.display = 'block';
      const opts = await rpc('get_subcontractor_company_options', { p_login_code: loginCode });
      $('pf-company-select').innerHTML = '<option value="">選択してください</option>' + (opts || []).map((c) => `<option value="${c.company_id}">${escapeHtml(c.company_name)}</option>`).join('');
    }
  } catch (e) { setErr('profile-error', e.message || '読み込みに失敗しました。'); }
}

async function saveProfile() {
  setErr('profile-error', '');
  const params = {
    p_login_code: loginCode,
    p_worker_name: $('pf-name').value.trim() || null,
    p_furigana: $('pf-furigana').value.trim() || null,
    p_birth_date: $('pf-birth').value || null,
    p_phone: $('pf-phone').value.trim() || null,
    p_address: $('pf-address').value.trim() || null,
    p_blood_type: $('pf-blood').value.trim() || null,
    p_emergency_contact_name: $('pf-ec-name').value.trim() || null,
    p_emergency_contact_relation: $('pf-ec-rel').value.trim() || null,
    p_emergency_contact_phone: $('pf-ec-phone').value.trim() || null,
  };
  if ($('pf-company-select-wrap').style.display !== 'none') {
    const cv = $('pf-company-select').value;
    if (cv) params.p_company_id = Number(cv);
  }
  try {
    const r = await rpc('update_my_subcontractor_profile', params);
    const row = Array.isArray(r) ? r[0] : r;
    if (row && row.company_name) currentWorker.company = row.company_name;
    if (params.p_worker_name) currentWorker.name = params.p_worker_name;
    $('done-title').textContent = '個人情報を保存しました';
    $('done-sub').textContent = '';
    showScreen('done');
  } catch (e) { setErr('profile-error', e.message || '保存に失敗しました。'); }
}

// ④ 資格(複数・専用マスター employee_qualifications を共通利用)
async function loadQualifications() {
  try {
    const rows = await rpc('get_my_subcontractor_qualifications', { p_login_code: loginCode });
    const list = $('pf-qual-list'); const empty = $('pf-qual-empty');
    if (!rows || !rows.length) { list.innerHTML = ''; empty.style.display = 'block'; return; }
    empty.style.display = 'none';
    list.innerHTML = rows.map((q) => `<div class="recent-item">${escapeHtml(q.qualification_name)}${q.qualification_number ? '（' + escapeHtml(q.qualification_number) + '）' : ''}${q.expiry_date ? '<span class="chip">期限 ' + q.expiry_date + '</span>' : ''} <button type="button" class="qual-del" data-id="${q.id}" style="float:right;background:none;color:var(--danger);width:auto;margin:0;padding:0 6px;">削除</button></div>`).join('');
    list.querySelectorAll('.qual-del').forEach((b) => b.addEventListener('click', async () => { await rpc('delete_my_subcontractor_qualification', { p_login_code: loginCode, p_id: Number(b.dataset.id) }).catch(() => {}); loadQualifications(); }));
  } catch (e) { $('pf-qual-list').innerHTML = ''; }
}
async function addQualification() {
  setErr('qual-error', '');
  const name = $('pf-qual-name').value.trim();
  if (!name) { setErr('qual-error', '資格・免許の名称を入力してください。'); return; }
  try {
    await rpc('submit_my_subcontractor_qualification', { p_login_code: loginCode, p_qualification_name: name, p_qualification_number: $('pf-qual-number').value.trim() || null, p_obtained_date: $('pf-qual-obtained').value || null, p_expiry_date: $('pf-qual-expiry').value || null });
    $('pf-qual-name').value = ''; $('pf-qual-number').value = ''; $('pf-qual-obtained').value = ''; $('pf-qual-expiry').value = '';
    await loadQualifications();
  } catch (e) { setErr('qual-error', e.message || '資格の追加に失敗しました。'); }
}
// ⑤ 健康診断(専用マスター employee_health_checkups を共通利用)
async function loadHealthCheckups() {
  try {
    const rows = await rpc('get_my_subcontractor_health_checkups', { p_login_code: loginCode });
    const list = $('pf-health-list'); const empty = $('pf-health-empty');
    if (!rows || !rows.length) { list.innerHTML = ''; empty.style.display = 'block'; return; }
    empty.style.display = 'none';
    list.innerHTML = rows.map((h) => `<div class="recent-item">実施 ${h.checkup_date}${h.next_due_date ? '<span class="chip">次回 ' + h.next_due_date + '</span>' : ''}</div>`).join('');
  } catch (e) { $('pf-health-list').innerHTML = ''; }
}
async function addHealthCheckup() {
  setErr('health-error', '');
  const d = $('pf-health-date').value;
  if (!d) { setErr('health-error', '健康診断の実施日を入力してください。'); return; }
  try {
    await rpc('submit_my_subcontractor_health_checkup', { p_login_code: loginCode, p_checkup_date: d, p_next_due_date: $('pf-health-next').value || null });
    $('pf-health-date').value = ''; $('pf-health-next').value = '';
    await loadHealthCheckups();
  } catch (e) { setErr('health-error', e.message || '健康診断の追加に失敗しました。'); }
}

// ⑤〜⑨ 出面
async function openAttendance() {
  showScreen('attendance');
  setErr('att-error', '');
  const d = todayJST();
  $('att-date').textContent = d + ' の日報';
  // 区分・人工リセット
  document.querySelectorAll('#att-worktype .seg').forEach((s, i) => s.classList.toggle('active', i === 0));
  $('att-headcount').value = '1'; $('att-overtime').value = '0'; $('att-night').checked = false; $('att-notes').value = '';
  $('att-newsite-wrap').style.display = 'none'; $('att-newsite').value = '';
  // ⑤ 現場候補: 当日の配置
  let sites = [];
  try {
    const asg = await rpc('get_my_subcontractor_assignments', { p_login_code: loginCode, p_report_date: d });
    sites = (asg || []).filter((a) => a.site_id).map((a) => ({ id: a.site_id, label: a.site_label || '(現場)' }));
  } catch (e) {}
  // 重複site_id除去
  const seen = {}; sites = sites.filter((s) => (seen[s.id] ? false : (seen[s.id] = true)));
  const opts = sites.map((s) => `<option value="${s.id}">${escapeHtml(s.label)}</option>`).join('');
  $('att-site').innerHTML = (opts || '') + '<option value="__new__">その他(現場名を入力)</option>';
  if (!sites.length) { $('att-site').value = '__new__'; $('att-newsite-wrap').style.display = 'block'; }
  // 既存の登録
  loadTodayAttendance(d);
}

async function loadTodayAttendance(d) {
  try {
    const r = await rpc('get_my_subcontractor_attendance', { p_login_code: loginCode, p_report_date: d });
    const rows = r || [];
    if (rows.length) {
      $('att-existing-wrap').style.display = 'block';
      $('att-existing-list').innerHTML = rows.map((x) => `<div class="recent-item">${escapeHtml(x.site_name || '(現場未設定)')}｜${escapeHtml(x.work_type || '')}｜残業${x.overtime_hours || 0}h${x.is_night_shift ? '｜夜勤' : ''}${x.reflected ? '<span class="chip">反映済</span>' : ''}</div>`).join('');
    } else { $('att-existing-wrap').style.display = 'none'; }
  } catch (e) { $('att-existing-wrap').style.display = 'none'; }
}

async function submitAttendance() {
  setErr('att-error', '');
  const wtEl = document.querySelector('#att-worktype .seg.active');
  const workType = wtEl ? wtEl.getAttribute('data-wt') : '終日';
  const siteVal = $('att-site').value;
  const entry = { work_type: workType, overtime_hours: Number($('att-overtime').value || 0), is_night_shift: $('att-night').checked, notes: $('att-notes').value.trim() || null };
  if (siteVal === '__new__') {
    const nm = $('att-newsite').value.trim();
    if (!nm) { setErr('att-error', '現場名を入力してください。'); return; }
    entry.new_site_name = nm;
  } else if (siteVal) {
    entry.site_id = Number(siteVal);
  } else { setErr('att-error', '現場を選択してください。'); return; }
  const hc = Number($('att-headcount').value);
  if (!(hc > 0)) { setErr('att-error', '人工を入力してください。'); return; }
  entry.headcount = hc;
  try {
    const r = await rpc('submit_my_subcontractor_attendance', { p_login_code: loginCode, p_report_date: todayJST(), p_entries: [entry] });
    const row = Array.isArray(r) ? r[0] : r;
    $('done-title').textContent = '日報を登録しました';
    $('done-sub').textContent = `${workType}｜${hc}人工${entry.overtime_hours ? '｜残業' + entry.overtime_hours + 'h' : ''}`;
    showScreen('done');
  } catch (e) { setErr('att-error', e.message || '登録に失敗しました。'); }
}

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Service Worker(収束保険つき)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      const hadController = !!navigator.serviceWorker.controller;
      const check = () => { try { reg.update(); } catch (e) {} };
      setInterval(check, 15 * 60 * 1000);
      window.addEventListener('focus', check);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) nw.postMessage({ type: 'SKIP_WAITING' });
        });
      });
      // 初回インストール時はreloadしない(無限reload防止)。以後の切替でのみ1回だけreload。
      let refreshed = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) return;
        if (refreshed) return; refreshed = true;
        window.location.reload();
      });
    }).catch(() => {});
  });
}

document.addEventListener('DOMContentLoaded', boot);
