(function (root) {
  'use strict';

  const SECTION = '概要';
  const RECORD = 'site-operation-v1';
  const DAY = 86400000;
  let generation = 0;
  const validTime = value => {
    if (value === null || value === undefined || value === '') return NaN;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : NaN;
  };
  const startTime = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? validTime(value + 'T00:00:00+09:00') : NaN;
  const identity = () => {
    const session = root.portalSession;
    if (!session?.connected?.()) return '';
    const person = session.identity?.();
    return person?.code ? JSON.stringify([person.kind || 'employee', person.code]) : '';
  };
  const escapeText = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function calculateSiteActionReminders({ profile = {}, rows = [], operation = {}, now = new Date() } = {}) {
    const current = validTime(now);
    const begin = startTime(profile.start);
    const finished = profile.status === '完了';
    const active = !finished && profile.status !== '着工前';
    const actions = rows.filter(row => !row?.deleted && row?.payload?.kind === 'site-action' && validTime(row.payload.occurredAt) <= current);
    const has = type => actions.some(row => row.payload.actionType === type);
    const pauseStart = validTime(operation.pausedAt);
    const paused = Number.isFinite(pauseStart) && pauseStart <= current;
    const pauses = Array.isArray(operation.pauses) ? operation.pauses : [];
    const pauseDataInvalid = !!operation.kind && operation.kind !== 'site-operation' || operation.pauses != null && !Array.isArray(operation.pauses) || !!operation.pausedAt && (!Number.isFinite(pauseStart) || pauseStart > current) || pauses.some(interval => !Number.isFinite(validTime(interval?.startedAt)) || !Number.isFinite(validTime(interval?.endedAt)) || validTime(interval.endedAt) < validTime(interval.startedAt));
    const surveys = actions.filter(row => row.payload.actionType === '調査')
      .map(row => validTime(row.payload.occurredAt)).filter(time => !Number.isFinite(begin) || time >= begin);
    const anchor = surveys.length ? Math.max(...surveys) : begin;
    let activeDays = null;
    if (Number.isFinite(current) && Number.isFinite(anchor) && !pauseDataInvalid) {
      let elapsed = Math.max(0, current - anchor);
      const intervals = [...pauses, ...(paused ? [{ startedAt: operation.pausedAt, endedAt: now }] : [])]
        .map(interval => [Math.max(anchor, validTime(interval.startedAt)), Math.min(current, validTime(interval.endedAt))])
        .filter(([from, to]) => to > from).sort((a, b) => a[0] - b[0]);
      let coveredTo = anchor;
      for (const [from, to] of intervals) {
        elapsed -= Math.max(0, to - Math.max(from, coveredTo));
        coveredTo = Math.max(coveredTo, to);
      }
      activeDays = Math.floor(Math.max(0, elapsed) / DAY);
    }
    return {
      beginningMissing: !has('開始挨拶'),
      endingMissing: !has('終了挨拶'),
      beginningRecorded: has('開始挨拶'),
      endingRecorded: has('終了挨拶'),
      paused,
      finished,
      activeDays,
      surveyDue: active && !paused && activeDays !== null && activeDays >= 10,
      startUnknown: !Number.isFinite(begin),
      pauseDataInvalid
    };
  }

  async function mount({ host, site, rows = [], onRecord } = {}) {
    if (!host || !site?.site_key || !root.siteSharedStore) return;
    const ticket = ++generation, actor = identity(), key = site.site_key, store = root.siteSharedStore;
    const live = () => host.isConnected && ticket === generation && actor && actor === identity();
    if (!actor) return;
    host.textContent = '現場の確認事項を読み込み中…';
    const operationKey = store.key(key, SECTION, RECORD);
    let record, pending;
    const read = async () => {
      const result = await store.list(key, SECTION);
      if (!live()) return false;
      record = result.find(row => row.id === RECORD && !row.deleted);
      const allPending = await store.pending();
      if (!live()) return false;
      pending = allPending.find(item => item.key === operationKey) || null;
      paint();
      return true;
    };
    const alert = message => { const area = host.querySelector('[data-site-operation-status]'); if (area) area.textContent = message; };
    const button = (label, action, className = 'secondary') => {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = className;
      element.textContent = label;
      element.addEventListener('click', action);
      return element;
    };
    const paint = () => {
      if (!live()) return;
      const state = calculateSiteActionReminders({ profile: site.profile, rows, operation: record?.payload, now: new Date() });
      host.replaceChildren();
      const panel = document.createElement('section');
      panel.className = 'panel';
      panel.dataset.siteActionReminders = '';
      panel.style.marginBottom = '20px';
      const title = document.createElement('h2');
      title.textContent = '挨拶・調査の確認';
      panel.append(title);
      const messages = [];
      if (state.beginningMissing) messages.push(['開始挨拶：未記録。現場へ行き、対応を記録してください。', '開始挨拶']);
      else messages.push(['開始挨拶：記録済み', 'recorded-beginning']);
      if (state.endingMissing) messages.push([state.finished ? '終了挨拶：未記録。現場へ行き、対応を記録してください。' : '終了挨拶：未記録（終了時に必ず実施）', '終了挨拶']);
      else messages.push(['終了挨拶：記録済み', 'recorded-ending']);
      if (state.surveyDue) messages.push(['稼働日数が10日以上です。現場へ調査に行ってください。', '調査']);
      if (state.paused) messages.push(['この現場は停止中です。調査の10日計算も停止しています。', '']);
      if (state.startUnknown && state.activeDays === null && !state.finished) messages.push(['着工日が未登録のため、調査の10日計算は始められません。', '']);
      if (state.pauseDataInvalid) messages.push(['停止記録を確認できません。管理者に確認してください。', '']);
      for (const [message, type] of messages) {
        const line = document.createElement('p');
        line.style.margin = '8px 0';
        const warning = type && !type.startsWith('recorded-');
        if (warning) { line.setAttribute('role', 'status'); line.style.fontWeight = 'bold'; line.style.color = '#a43d20'; line.dataset.siteActionWarning = type; }
        if (type.startsWith('recorded-')) line.dataset.siteActionRecorded = type.slice('recorded-'.length);
        line.textContent = (warning ? '⚠ ' : type.startsWith('recorded-') ? '✓ ' : '') + message;
        panel.append(line);
        if (warning && typeof onRecord === 'function' && store.access(key, '現場アクション')?.manage) panel.append(button(type + 'を記録', () => onRecord(type)));
      }
      if (state.activeDays !== null && !state.finished && site.profile?.status !== '着工前') {
        const elapsed = document.createElement('p');
        elapsed.className = 'meta';
        elapsed.textContent = '前回の調査または着工日からの稼働日数：' + state.activeDays + '日';
        panel.append(elapsed);
      }
      if (store.access(key, SECTION)?.manage && !state.finished && !state.pauseDataInvalid) {
        const toggle = button(state.paused ? '稼働を再開' : '現場の稼働を停止', () => changePause(!state.paused));
        toggle.dataset.siteOperationToggle = state.paused ? 'resume' : 'pause';
        panel.append(toggle);
      }
      const status = document.createElement('p');
      status.dataset.siteOperationStatus = '';
      status.setAttribute('role', 'status');
      panel.append(status);
      if (pending) {
        status.textContent = '停止・再開の送信結果が未確認です。状態を確認してください。';
        panel.querySelectorAll('button').forEach(item => item.disabled = true);
        panel.append(button('同じ内容の送信結果を再確認', async () => {
          if (!live()) return;
          try { await store.retry(operationKey); if (live()) await read(); }
          catch (error) { if (live()) alert(error.message); }
        }));
        panel.append(button('保存済みの状態と比較', compare));
      }
      host.append(panel);
    };
    const changePause = async pause => {
      if (!live() || !store.access(key, SECTION)?.manage) return;
      const snapshot = record?.payload || {}, current = calculateSiteActionReminders({ profile: site.profile, rows, operation: snapshot });
      if (current.paused === pause) return;
      const controls = [...host.querySelectorAll('button')];
      controls.forEach(item => item.disabled = true);
      alert('共有先に保存しています…');
      const stamp = new Date().toISOString();
      const next = { ...snapshot, kind: 'site-operation', pauses: Array.isArray(snapshot.pauses) ? snapshot.pauses.slice() : [] };
      if (pause) next.pausedAt = stamp;
      else {
        next.pauses.push({ startedAt: snapshot.pausedAt, endedAt: stamp });
        next.pausedAt = null;
      }
      try {
        const result = await store.save(key, SECTION, RECORD, next, { revision: Number(record?.revision || 0) });
        if (!live()) return;
        record = result;
        await read();
      } catch (error) {
        if (live()) { await read().catch(() => {}); alert(error.message + ' 保存結果を確認してください。'); }
      } finally { if (live() && !pending) host.querySelectorAll('button').forEach(item => item.disabled = false); }
    };
    const compare = async () => {
      if (!live()) return;
      try {
        const latest = (await store.list(key, SECTION)).find(row => row.id === RECORD && !row.deleted);
        if (!live()) return;
        const outstanding = (await store.pending()).find(item => item.key === operationKey);
        if (!live()) return;
        const comparison = document.createElement('div');
        comparison.innerHTML = '<p>保存済み：' + escapeText(latest?.payload?.pausedAt ? '停止中' : '稼働中') + ' ／ 送信未確認：' + escapeText(outstanding?.value?.p_payload?.pausedAt ? '停止中' : '稼働中') + '</p>';
        comparison.append(button('保存済みの状態を採用', async () => {
          if (!live()) return;
          try {
            const now = (await store.pending()).find(item => item.key === operationKey);
            if (!live()) return;
            if (now?.requestId !== outstanding?.requestId) throw Error('送信待ちの内容が変わりました。もう一度比較してください。');
            if (now) await store.resolvePending(operationKey, now.requestId);
            if (live()) await read();
          } catch (error) { if (live()) alert(error.message); }
        }));
        host.querySelector('[data-site-operation-status]')?.after(comparison);
      } catch (error) { if (live()) alert(error.message); }
    };
    try { await read(); }
    catch (error) {
      if (live()) {
        host.replaceChildren();
        const message = document.createElement('p');
        message.setAttribute('role', 'alert');
        message.textContent = '現場の確認事項を読み込めません：' + error.message;
        host.append(message, button('再読込', read));
      }
    }
  }

  root.mountSiteActionReminders = mount;
  root.calculateSiteActionReminders = calculateSiteActionReminders;
  if (typeof module !== 'undefined' && module.exports) module.exports = { calculateSiteActionReminders };
  if (root.addEventListener) root.addEventListener('portal-session-ready', () => { generation++; });
})(typeof window !== 'undefined' ? window : globalThis);


