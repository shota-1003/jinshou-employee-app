'use strict';

// pending-approval-classifier.jsのisExpectedPendingApprovalError()(app.jsのrpc()内で
// 「Production障害として報告するか」を判定するために使われる関数)を、本番Supabaseへ
// 接続せずに単体で検証するスクリプト。resume_employee_sessionが管理者の承認待ちを返す
// ケースだけを正しく抑制対象にでき、無関係な他RPCのエラー(admin_decide_device_approval等)や、
// resume_employee_session自身が返す他の異常(セッション失効・却下等)まで巻き込んで
// 抑制していないことを機械的に確認する。
// 実行: node scripts/verify-pending-approval-suppression.js

const path = require('path');

const { isExpectedPendingApprovalError } = require(path.join(__dirname, '..', 'pending-approval-classifier.js'));

const cases = [
  {
    name: '承認待ちの新規端末(resume_employee_session) → 抑制する',
    rpcName: 'resume_employee_session',
    message: 'この端末はまだ管理者の承認待ちです。承認され次第ご利用いただけます',
    expected: true,
  },
  {
    name: '無関係な他RPC(admin_decide_device_approval)の類似メッセージ → 抑制しない',
    rpcName: 'admin_decide_device_approval',
    message: '承認待ちの端末が見つかりませんでした',
    expected: false,
  },
  {
    name: 'resume_employee_sessionでもメッセージが無関係 → 抑制しない',
    rpcName: 'resume_employee_session',
    message: 'このアカウントは現在ご利用いただけません',
    expected: false,
  },
  {
    name: '無関係なRPC名かつ無関係なメッセージ → 抑制しない',
    rpcName: 'submit_daily_report',
    message: '通信エラー(500)',
    expected: false,
  },
];

let failed = 0;
for (const c of cases) {
  const actual = isExpectedPendingApprovalError(c.rpcName, c.message);
  const ok = actual === c.expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${c.name} (expected=${c.expected}, actual=${actual})`);
}

if (failed > 0) {
  console.error(`${failed}件失敗しました`);
  process.exit(1);
}
console.log('全件成功しました');
