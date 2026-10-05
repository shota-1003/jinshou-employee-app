'use strict';

// Candidate shared by the site KY page and the two existing daily-report portals.
// It carries only an opaque site key and a date. The destination fetches all report
// suggestions from site_ky_daily_report_source after its own login succeeds.
(function (root) {
  const KEY = 'jinshou_ky_daily_report_handoff_v1';
  const MAX_AGE_MS = 15 * 60 * 1000;
  const validDate = (value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(value + 'T00:00:00Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  const validActor = (kind, code) => (kind === 'employee' || kind === 'worker') &&
    typeof code === 'string' && code.length > 0 && code.length <= 100;
  const clear = () => { try { root.sessionStorage.removeItem(KEY); } catch (_) {} };

  function stage({ actorKind, actorCode, siteKey, date, recordId }) {
    if (!validActor(actorKind, actorCode) || !validDate(date) ||
        typeof siteKey !== 'string' || !siteKey || siteKey.length > 200 ||
        (recordId != null && (typeof recordId !== 'string' || recordId.length > 200))) {
      throw new Error('KYの日報引継ぎ情報を確認できません');
    }
    const value = { version: 1, actorKind, actorCode, siteKey, date,
      recordId: recordId || null, createdAt: Date.now() };
    root.sessionStorage.setItem(KEY, JSON.stringify(value));
    return value;
  }

  // Call only after portal login. A mismatched identity is discarded, not retried.
  function peek(actorKind, actorCode) {
    let value;
    try { value = JSON.parse(root.sessionStorage.getItem(KEY) || 'null'); } catch (_) { clear(); return null; }
    if (!value) return null;
    if (value.version !== 1 || !validActor(value.actorKind, value.actorCode) ||
        !validDate(value.date) || typeof value.siteKey !== 'string' ||
        !value.siteKey || value.siteKey.length > 200 ||
        !Number.isFinite(value.createdAt) || Date.now() - value.createdAt > MAX_AGE_MS ||
        value.createdAt > Date.now() + 60000 || value.actorKind !== actorKind ||
        value.actorCode !== actorCode) {
      clear(); return null;
    }
    return value;
  }
  function consume(actorKind, actorCode, date) {
    const value = peek(actorKind, actorCode);
    if (!value) return null;
    clear();
    return value.date === date ? value : null;
  }

  // Treat server fields as untrusted transport values before touching a form.
  function reportSource(value, handoff, actorKey) {
    const row = Array.isArray(value) ? value[0] : value;
    if (!row || row.eligible !== true || row.siteKey !== handoff.siteKey ||
        row.date !== handoff.date || row.actorKey !== actorKey ||
        !Number.isSafeInteger(Number(row.portalSiteId)) || Number(row.portalSiteId) <= 0 ||
        typeof row.workText !== 'string' ||
        (handoff.recordId && row.kyRecordId !== handoff.recordId)) return null;
    return { siteId: Number(row.portalSiteId), siteName: typeof row.siteName === 'string' ? row.siteName.trim() : '',
      dailyReportSiteEligible: row.dailyReportSiteEligible === true, notes: row.workText.trim(),
      recordId: row.kyRecordId };
  }

  root.KyDailyReportHandoff = { KEY, stage, peek, consume, clear, reportSource };
})(typeof window === 'undefined' ? globalThis : window);

'use strict';

// Candidate site-management adapter. Install after the handoff helper loads.
// The KY end-signature button supplies its current Session and panel-validity
// closure; the destination RPC independently verifies the effective signature.
(function (root) {
  root.installKyDailyReportHandoff = function ({ employeeUrl, workerUrl }) {
    const destinations = {
      employee: new URL(employeeUrl, root.location.href),
      worker: new URL(workerUrl, root.location.href),
    };
    for (const destination of Object.values(destinations)) {
      if (destination.origin !== root.location.origin || destination.protocol !== 'https:') {
        throw new Error('日報入口の配信元を確認できません');
      }
    }
    root.openKyDailyReport = function ({ session, valid, status }) {
    try {
      if (typeof valid === 'function' && !valid()) throw new Error('画面が更新されました。KYを開き直してください。');
      session.check();
      const actor = session.actor();
      const date = session.draft?.kyCanonical?.date;
      const destination = new URL(destinations[actor.kind].href);
      root.KyDailyReportHandoff.stage({
        actorKind: actor.kind, actorCode: actor.code,
        siteKey: session.site, date, recordId: session.id,
      });
      if (actor.kind === 'employee') {
        destination.searchParams.set('next', 'daily-report');
        destination.searchParams.set('date', date);
      }
      root.location.assign(destination.href);
    } catch (e) {
      if (status) status.textContent = e.message || '日報を開けませんでした';
    }
    };
  };
})(typeof window === 'undefined' ? globalThis : window);
