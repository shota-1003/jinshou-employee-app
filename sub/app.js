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
    // 端末トークンでセッション再開(IDは端末が保持・入力不要)
    try {
      const r = await rpc('subcontractor_resume_session', { p_login_code: loginCode });
      const row = Array.isArray(r) ? r[0] : r;
      if (row && row.out_worker_id) { currentWorker = { name: row.out_worker_name, company: row.out_company_name }; enterHome(); return; }
    } catch (e) { /* 期限切れ等 → 暗証番号ログインへ */ }
    // トークンが無効: この端末は登録済みなので暗証番号だけで再ログイン
    $('pin-entry-name').textContent = 'おかえりなさい';
    showScreen('pin-entry');
    return;
  }
  showScreen('welcome');
}

function bindEvents() {
  // 入口: 外注登録(自己登録) / 機種変更(本人再確認)
  $('welcome-register-btn').addEventListener('click', openRegister);
  $('welcome-relink-btn').addEventListener('click', openRelink);
  $('register-submit').addEventListener('click', doSelfRegister);
  $('relink-submit').addEventListener('click', doRelink);

  // 暗証番号ログイン(2回目以降・IDは端末が記憶)
  $('pin-entry-submit').addEventListener('click', doPinLogin);
  $('pin-entry-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doPinLogin(); });
  $('pin-entry-switch').addEventListener('click', () => { showScreen('welcome'); });

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

// 会社選択肢を(認証不要で)読み込む
async function loadCompanyOptions(selectId) {
  try {
    const opts = await rpc('list_subcontractor_companies_public', {});
    $(selectId).innerHTML = '<option value="">選択してください</option>' + (opts || []).map((c) => `<option value="${c.company_id}">${escapeHtml(c.company_name)}</option>`).join('');
  } catch (e) { $(selectId).innerHTML = '<option value="">(会社一覧を取得できませんでした)</option>'; }
}
async function openRegister() {
  setErr('register-error', ''); showScreen('register');
  await loadCompanyOptions('reg-company');
}
async function openRelink() {
  setErr('relink-error', ''); showScreen('relink');
  await loadCompanyOptions('relink-company');
}

// 外注 自己登録(ID自動採番)。登録完了で loginCode/token を端末保持し、次回は暗証番号だけで再ログイン。
async function doSelfRegister() {
  setErr('register-error', '');
  const companyId = $('reg-company').value;
  const name = $('reg-name').value.trim();
  const phone = $('reg-phone').value.trim();
  const pin = $('reg-pin').value.trim();
  const pin2 = $('reg-pin2').value.trim();
  if (!companyId) { setErr('register-error', '所属する外注会社を選んでください。'); return; }
  if (!name) { setErr('register-error', '氏名を入力してください。'); return; }
  if (!phone) { setErr('register-error', '電話番号を入力してください。'); return; }
  if (!pin || pin.length < 4) { setErr('register-error', '暗証番号は4〜6桁で決めてください。'); return; }
  if (pin !== pin2) { setErr('register-error', '暗証番号(確認)が一致しません。'); return; }
  try {
    const r = await rpc('subcontractor_self_register', { p_company_id: Number(companyId), p_worker_name: name, p_pin: pin, p_furigana: $('reg-furigana').value.trim() || null, p_phone: phone });
    const row = Array.isArray(r) ? r[0] : r;
    if (!row || !row.out_device_token) throw new Error('登録に失敗しました。');
    loginCode = row.out_login_code; deviceToken = row.out_device_token;
    currentWorker = { name: row.out_worker_name, company: row.out_company_name };
    saveAuth();
    ['reg-name', 'reg-furigana', 'reg-phone', 'reg-pin', 'reg-pin2'].forEach((id) => { $(id).value = ''; });
    // 登録後は資格・健診の登録へ誘導
    enterHome();
    openProfile();
  } catch (e) { setErr('register-error', e.message || '登録に失敗しました。'); }
}

// 機種変更/別端末: 会社+氏名+電話+暗証番号で本人再確認 → 既存IDへ端末再紐付け(新規作成しない)。
async function doRelink() {
  setErr('relink-error', '');
  const companyId = $('relink-company').value;
  const name = $('relink-name').value.trim();
  const phone = $('relink-phone').value.trim();
  const pin = $('relink-pin').value.trim();
  if (!companyId || !name || !phone || !pin) { setErr('relink-error', '会社・氏名・電話番号・暗証番号をすべて入力してください。'); return; }
  try {
    const r = await rpc('subcontractor_relink_device', { p_company_id: Number(companyId), p_worker_name: name, p_phone: phone, p_pin: pin });
    const row = Array.isArray(r) ? r[0] : r;
    if (!row || !row.out_device_token) throw new Error('本人確認に失敗しました。');
    loginCode = row.out_login_code; deviceToken = row.out_device_token;
    currentWorker = { name: row.out_worker_name, company: row.out_company_name };
    saveAuth();
    ['relink-name', 'relink-phone', 'relink-pin'].forEach((id) => { $(id).value = ''; });
    enterHome();
  } catch (e) { setErr('relink-error', e.message || '本人確認に失敗しました。'); }
}

// (旧・会社発行コードによる初回ログイン doFirstLogin は廃止。自己登録 doSelfRegister に統合)

function doLogout() {
  rpc('subcontractor_logout', { p_login_code: loginCode }).catch(() => {});
  clearAuth();
  showScreen('welcome');
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
    // 必須未入力(既存データが空の場合)は破壊的補完せず、開いた時に入力を促す(仕様1)
    const missing = !(p.worker_name) || !(p.phone) || !(p.blood_type) || !(p.emergency_contact_name) || !(p.emergency_contact_relation) || !(p.emergency_contact_phone);
    const notice = $('pf-required-notice'); if (notice) notice.style.display = missing ? 'block' : 'none';
    // ④⑤ 資格・健診(複数・共通マスター)。資格はマスター選択式。
    await loadQualMaster();
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
  // 必須: 氏名・電話・血液型・緊急連絡先(氏名・続柄・電話)。未入力は保存不可(仕様1)。
  const blood = $('pf-blood').value.trim(), ecName = $('pf-ec-name').value.trim(), ecRel = $('pf-ec-rel').value.trim(), ecPhone = $('pf-ec-phone').value.trim();
  const name = $('pf-name').value.trim(), phone = $('pf-phone').value.trim();
  const missing = !name || !phone || !blood || !ecName || !ecRel || !ecPhone;
  const notice = $('pf-required-notice'); if (notice) notice.style.display = missing ? 'block' : 'none';
  if (missing) { setErr('profile-error', '必須項目(氏名・電話・血液型・緊急連絡先の氏名/続柄/電話)をすべて入力してください。'); return; }
  const params = {
    p_login_code: loginCode,
    p_worker_name: name || null,
    p_furigana: $('pf-furigana').value.trim() || null,
    p_birth_date: $('pf-birth').value || null,
    p_phone: phone || null,
    p_address: $('pf-address').value.trim() || null,
    p_blood_type: blood || null,
    p_emergency_contact_name: ecName || null,
    p_emergency_contact_relation: ecRel || null,
    p_emergency_contact_phone: ecPhone || null,
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
    list.innerHTML = rows.map((q) => `<div class="recent-item" data-qname="${escapeHtml(q.qualification_name)}">${escapeHtml(q.qualification_name)}${q.qualification_number ? '（' + escapeHtml(q.qualification_number) + '）' : ''}${q.expiry_date ? '<span class="chip">期限 ' + q.expiry_date + '</span>' : ''} <button type="button" class="qual-del" data-id="${q.id}" style="float:right;background:none;color:var(--danger);width:auto;margin:0;padding:0 6px;">削除</button></div>`).join('');
    list.querySelectorAll('.qual-del').forEach((b) => b.addEventListener('click', async () => { await rpc('delete_my_subcontractor_qualification', { p_login_code: loginCode, p_id: Number(b.dataset.id) }).catch(() => {}); loadQualifications(); }));
  } catch (e) { $('pf-qual-list').innerHTML = ''; }
}
// 資格マスターをカテゴリ別(optgroup)に読み込み、選択式にする(自由入力ではなくマスター選択・仕様2/3)
async function loadQualMaster() {
  try {
    const rows = await rpc('list_qualification_master', { p_login_code: loginCode });
    const sel = $('pf-qual-select');
    const cats = {};
    (rows || []).forEach((r) => { (cats[r.category] = cats[r.category] || []).push(r); });
    let html = '<option value="">選択してください</option>';
    Object.keys(cats).forEach((cat) => {
      // 免許は license_types_master 由来(license_type_id、idはnull)。資格は qualification_master 由来(id)。
      // 二重管理しないため、免許は共通の免許マスターから来る。値は免許なら "lic:<id>"、資格なら master id。
      html += `<optgroup label="${escapeHtml(cat)}">` + cats[cat].map((r) => {
        const v = (r.license_type_id != null) ? ('lic:' + r.license_type_id) : String(r.id);
        return `<option value="${v}" data-name="${escapeHtml(r.qualification_name)}">${escapeHtml(r.qualification_name)}</option>`;
      }).join('') + '</optgroup>';
    });
    // 最後に「その他（自由記入）」。選ぶと自由入力欄を出す。
    html += '<option value="__other__">その他（自由記入）</option>';
    sel.innerHTML = html;
    sel.onchange = () => { $('pf-qual-other-wrap').style.display = (sel.value === '__other__') ? 'block' : 'none'; };
  } catch (e) { $('pf-qual-select').innerHTML = '<option value="">(資格一覧を取得できませんでした)</option>'; }
}
async function addQualification() {
  setErr('qual-error', '');
  const sel = $('pf-qual-select');
  const val = sel.value;
  if (!val) { setErr('qual-error', '持っている資格を一覧から選んでください。'); return; }
  // 既に登録済みの資格名は重複警告(その他/マスターとも)。
  const existingNames = Array.from(document.querySelectorAll('#pf-qual-list .recent-item')).map((el) => (el.dataset.qname || '').trim());
  const targetName = (val === '__other__') ? $('pf-qual-other').value.trim() : (sel.options[sel.selectedIndex].dataset.name || '').trim();
  if (val === '__other__' && !targetName) { setErr('qual-error', '資格・免許名を入力してください。'); return; }
  if (targetName && existingNames.includes(targetName)) { setErr('qual-error', `「${targetName}」は既に登録済みです（重複登録はできません）。`); return; }
  try {
    if (val === '__other__') {
      await rpc('submit_my_subcontractor_qualification', { p_login_code: loginCode, p_qualification_name: targetName });
      $('pf-qual-other').value = '';
    } else if (val.startsWith('lic:')) {
      // 免許(共通の免許マスター license_types_master 由来)
      await rpc('submit_my_subcontractor_qualification_selected', { p_login_code: loginCode, p_license_type_id: Number(val.slice(4)) });
    } else {
      await rpc('submit_my_subcontractor_qualification_selected', { p_login_code: loginCode, p_master_id: Number(val) });
    }
    sel.value = ''; $('pf-qual-other-wrap').style.display = 'none';
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
  if ($('att-trip')) $('att-trip').checked = false;
  $('att-newsite-wrap').style.display = 'none'; $('att-newsite').value = '';
  // ⑤ 現場候補: 正式な現場マスター(配置カレンダー→最近→有効現場マスターの優先順)。カテゴリタグは出さない。
  let sites = [];
  try {
    const cand = await rpc('get_my_subcontractor_site_candidates', { p_login_code: loginCode, p_date: d });
    sites = (cand || []).filter((a) => a.site_id).map((a) => ({ id: a.site_id, label: (a.site_name || '(現場)') + (a.source === '配置' ? '（本日の配置）' : a.source === '最近' ? '（最近）' : '') }));
  } catch (e) {}
  const seen = {}; sites = sites.filter((s) => (seen[s.id] ? false : (seen[s.id] = true)));
  const opts = sites.map((s) => `<option value="${s.id}">${escapeHtml(s.label)}</option>`).join('');
  $('att-site').innerHTML = (opts || '') + '<option value="__new__">その他(一覧にない現場を入力)</option>';
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
  const entry = { work_type: workType, overtime_hours: Number($('att-overtime').value || 0), is_night_shift: $('att-night').checked, is_business_trip: $('att-trip') ? $('att-trip').checked : false, notes: $('att-notes').value.trim() || null };
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
