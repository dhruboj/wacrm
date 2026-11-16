-- ============================================================
-- 043_transactional_message_log
--
-- Minimal audit trail for transactional sends (POST /api/v1/messages
-- with "transactional": true — one-time codes). Those sends create no
-- contact, conversation or message row, so this is the only record.
--
-- Deliberately minimal: template name, the phone's LAST 4 DIGITS, Meta's
-- message id and the status. Never the code, never the full number.
--
-- Written by the API (service role) at send time ('sent' / 'failed');
-- the status webhook moves it on to 'delivered' / 'read' / 'failed'.
-- Account members can read their rows; nobody writes through RLS.
-- ============================================================

CREATE TABLE IF NOT EXISTS transactional_message_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  api_key_id          uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  template_name       text NOT NULL CHECK (length(template_name) BETWEEN 1 AND 512),
  phone_last4         text NOT NULL CHECK (phone_last4 ~ '^[0-9]{4}$'),
  whatsapp_message_id text,
  status              text NOT NULL CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  error_code          text CHECK (error_code IS NULL OR length(error_code) <= 32),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Status webhook lookups by Meta message id.
CREATE INDEX IF NOT EXISTS transactional_message_log_wamid_idx
  ON transactional_message_log (whatsapp_message_id)
  WHERE whatsapp_message_id IS NOT NULL;

-- "Recent sends for this account" listings.
CREATE INDEX IF NOT EXISTS transactional_message_log_account_created_idx
  ON transactional_message_log (account_id, created_at DESC);

ALTER TABLE transactional_message_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS transactional_message_log_select ON transactional_message_log;
CREATE POLICY transactional_message_log_select ON transactional_message_log FOR SELECT
  USING (is_account_member(account_id));
