-- 事前申請送信時の「Could not choose the best candidate function」エラー修正
-- (task_id=3859、task_id=3808/3856と同系統のPostgREST関数オーバーロード曖昧エラー)
--
-- 原因:
-- public.submit_entertainment_preapproval に2つのオーバーロードが同時に存在していた。
--   1) (11引数、旧版): p_note までの11引数のみ。過去日を無条件で拒否する古いロジック。
--   2) (13引数、新版): 旧版と同じ11引数に加え、p_is_special_late_application boolean
--      DEFAULT false, p_late_reason text DEFAULT NULL を追加した「特別後日申請」対応版。
-- フロントエンド(app.js)の通常事前申請フォームは11個の名前付き引数だけを渡して呼び出す。
-- この呼び出しは「旧版(11引数ちょうど)」にも「新版(残り2引数はDEFAULTで補完)」にも
-- 同等に一致するため、PostgRESTが候補を一意に決められず
-- 「Could not choose the best candidate function」エラーとなっていた。
--
-- 対応:
-- 新版(13引数、特別後日申請・現物の出社除外例外ロジックを含む、より新しく完全な実装)を
-- 正とし、旧版(11引数)をDROPして一本化する。旧版に依存するビュー・権限付与は
-- pg_depend / information_schema.role_routine_grants で事前確認済みで存在しない
-- (deps=[], grants=[])ため、安全にDROPできる。

DROP FUNCTION IF EXISTS public.submit_entertainment_preapproval(
  text, timestamptz, text, numeric, text, bigint, text, text, integer, text[], text
);
