// ============================================================
// Transactional template send — no contact, no conversation, no
// stored message.
//
// For one-time codes and similar transactional notifications sent by
// an external system (POST /api/v1/messages with "transactional": true).
// Unlike sendMessageToConversation, this does NOT find-or-create a
// contact or conversation and does NOT persist the message (so a
// verification code never lands in the inbox or the database).
//
// Each send writes one row to transactional_message_log (migration
// 043): template name, the phone's last 4 digits, Meta's message id
// and the status. Never the code, never the full number. Delivery
// status updates arrive later through the status webhook.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';

export interface TransactionalTemplateParams {
  to: string;
  templateName: string;
  templateLanguage?: string | null;
  templateParams?: string[];
  templateMessageParams?: unknown;
  /** The API key making the send, recorded in the audit log. */
  apiKeyId?: string | null;
  /** Codes-only keys: the template must be a synced Authentication template. */
  requireAuthenticationCategory?: boolean;
}

/** Meta's numeric error code from a thrown Meta error, e.g. "(#132000) …" → "132000". */
export function metaErrorCode(message: string): string {
  const m = message.match(/#(\d{3,7})/) ?? message.match(/\b(\d{6})\b/);
  return m ? m[1] : 'meta_error';
}

async function writeLog(
  db: SupabaseClient,
  row: {
    account_id: string;
    api_key_id: string | null;
    template_name: string;
    phone_last4: string;
    whatsapp_message_id: string | null;
    status: 'sent' | 'failed';
    error_code: string | null;
  }
): Promise<void> {
  // The send already happened (or failed); a logging problem must not
  // change the API response. The row holds no code or full number, so
  // the error message is safe to log.
  try {
    const { error } = await db.from('transactional_message_log').insert(row);
    if (error) console.error('[send-transactional] audit log insert failed:', error.message);
  } catch (err) {
    console.error(
      '[send-transactional] audit log insert threw:',
      err instanceof Error ? err.message : err
    );
  }
}

export async function sendTransactionalTemplate(
  db: SupabaseClient,
  accountId: string,
  p: TransactionalTemplateParams
): Promise<{ whatsappMessageId: string }> {
  const to = sanitizePhoneForMeta(p.to);
  if (!isValidE164(to)) {
    throw new SendMessageError('bad_request', 'Invalid phone number format', 400);
  }

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', accountId)
    .single();
  if (configError || !config) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  const resolved = await resolveTemplateRow(db, accountId, p.templateName, p.templateLanguage);
  if (resolved.malformed) {
    throw new SendMessageError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it.',
      500
    );
  }
  if (p.requireAuthenticationCategory && resolved.row?.category !== 'Authentication') {
    throw new SendMessageError(
      'forbidden',
      resolved.row
        ? 'This API key can only send Authentication-category templates'
        : 'Template not found locally — run "Sync from Meta" in Settings first',
      403
    );
  }

  const log = {
    account_id: accountId,
    api_key_id: p.apiKeyId ?? null,
    template_name: p.templateName,
    phone_last4: to.slice(-4),
  };

  let messageId: string;
  try {
    const result = await sendTemplateMessage({
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
      to,
      templateName: p.templateName,
      language: resolved.language,
      template: resolved.row ?? undefined,
      messageParams: (p.templateMessageParams as SendTimeParams | undefined) ?? undefined,
      params: p.templateParams ?? [],
    });
    messageId = result.messageId;
  } catch (err) {
    // Never log the payload: it may contain a one-time code.
    const message = err instanceof Error ? err.message : 'Unknown Meta API error';
    await writeLog(db, { ...log, whatsapp_message_id: null, status: 'failed', error_code: metaErrorCode(message) });
    throw new SendMessageError('meta_error', `Meta API error: ${message}`, 502);
  }

  await writeLog(db, { ...log, whatsapp_message_id: messageId, status: 'sent', error_code: null });
  return { whatsappMessageId: messageId };
}
