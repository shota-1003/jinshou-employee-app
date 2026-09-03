'use strict';

// resume_employee_session()が返す「この端末はまだ管理者の承認待ちです」は、新規端末が
// 管理者の承認待ちであるという想定内の通常フロー(呼び出し元のtryResumeDeviceSession()が
// 専用のpending画面へ導く)であり、実際のProduction障害ではないため、app.jsのrpc()は
// これをClientErrorReporterへ報告しない。
//
// 2026-09-03: 以前はmessage.includes('承認待ち')という広い一致条件だったため、
// admin_decide_device_approval()が返す別種のエラー「承認待ちの端末が見つかりませんでした」
// (管理者が既に処理済みの端末を再度承認/却下しようとした場合の不整合、本来は報告すべき異常)
// まで巻き込んで一律に除外してしまっていた。呼び出し元RPC名を厳密一致させたうえで、
// メッセージも「まだ管理者の承認待ちです」という合言葉部分のみで判定することで、
// 将来の語尾・句読点の表記ゆれには追随しつつ、無関係な他RPCのエラーは巻き込まない。
//
// app.jsから直接呼べるようwindowへ公開しつつ、scripts/verify-pending-approval-suppression.js
// がNode単体でこの分類ロジックだけを検証できるようmodule.exportsも行う(ブラウザに
// module/windowが片方しか無くてもエラーにならないよう、それぞれtypeofで存在を確認する)。
function isExpectedPendingApprovalError(name, message) {
  return name === 'resume_employee_session'
    && typeof message === 'string'
    && message.includes('まだ管理者の承認待ちです');
}

if (typeof module !== 'undefined') module.exports = { isExpectedPendingApprovalError };
if (typeof window !== 'undefined') window.isExpectedPendingApprovalError = isExpectedPendingApprovalError;
