// ============================================================
// POST /api/v1/messages — send a WhatsApp message via the public API.
//
// The headline public endpoint (issue #245). Unlike the dashboard's
// `/api/whatsapp/send` (which takes an internal `conversation_id`),
// this takes a phone number — what an external automation actually
// has — resolves-or-creates the contact + conversation, then runs the
// same shared send core.
//
// Auth: API key with the `messages:send` scope, or with
// `messages:send_transactional`, which may ONLY make transactional
// sends of allow-listed Authentication templates (one-time codes).
// Account context (and the service-role client) come from `requireApiKey`.
//
// Body:
//   {
//     "to": "+14155550123",                 // required, E.164
//     "type": "text",                        // text|template|image|video|document|audio (default: text)
//     "text": "Hello!",                      // text body, or media caption
//     "media_url": "https://…/file.pdf",     // required for image/video/document/audio
//     "filename": "invoice.pdf",             // optional, document filename
//     "template": {                          // required when type=template
//       "name": "order_update",
//       "language": "en_US",
//       "params": ["A123"] | { "body": [...] }   // array = positional body; object = structured
//     },
//     "reply_to_message_id": "<uuid>",       // optional, must be in the same conversation
//     "name": "Jane Doe",                    // optional, names a newly-created contact
//     "transactional": true                  // optional, templates only: send without
//                                            // creating a contact/conversation or storing
//                                            // the message (one-time codes)
//   }
//
// Authentication templates: pass the code as template.params.otp
// ({ "otp": "123456" }); it fills the body {{1}} and the OTP button.
//
// Response (201):
//   { "data": { "message_id", "whatsapp_message_id", "conversation_id",
//               "contact_id", "contact_created" } }
//   transactional: { "data": { "whatsapp_message_id", "transactional": true } }
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { hasScope, isTransactionalTemplateAllowed } from '@/lib/api-keys/scopes';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import {
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError,
} from '@/lib/whatsapp/send-message';
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive';
import { sendTransactionalTemplate } from '@/lib/whatsapp/send-transactional';

export async function POST(request: Request) {
  try {
    // Scope is checked below: either messages:send (full) or
    // messages:send_transactional (codes only).
    const ctx = await requireApiKey(request);
    const fullSend = hasScope(ctx.scopes, 'messages:send');
    const transactionalOnly =
      !fullSend && hasScope(ctx.scopes, 'messages:send_transactional');
    if (!fullSend && !transactionalOnly) {
      return fail('forbidden', "This API key is missing the 'messages:send' scope", 403);
    }

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const to = typeof body.to === 'string' ? body.to.trim() : '';
    if (!to) {
      return fail('bad_request', "'to' is required", 400);
    }

    const type = typeof body.type === 'string' ? body.type : 'text';

    if (transactionalOnly) {
      const name =
        body.template && typeof body.template === 'object'
          ? (body.template as Record<string, unknown>).name
          : undefined;
      if (
        body.transactional !== true ||
        type !== 'template' ||
        typeof name !== 'string' ||
        !isTransactionalTemplateAllowed(name)
      ) {
        return fail(
          'forbidden',
          'This API key can only send allow-listed one-time-code templates with "transactional": true',
          403
        );
      }
    }

    // Unpack the optional `template` object into the flat params the
    // send core expects. `params` as an array → legacy positional body
    // params; as an object → structured header/body/button params.
    const template =
      body.template && typeof body.template === 'object'
        ? (body.template as Record<string, unknown>)
        : null;
    const templateParams = Array.isArray(template?.params)
      ? (template.params as unknown[]).filter(
          (p): p is string => typeof p === 'string'
        )
      : undefined;
    const templateMessageParams =
      template?.params && !Array.isArray(template.params)
        ? template.params
        : undefined;

    // Validate the message shape BEFORE resolveConversationByPhone
    // finds-or-creates a contact + conversation, so a bad payload 400s
    // without leaving an orphan contact/conversation behind.
    // Validated by `validateSendMessageParams` below; the cast just bridges
    // the untyped JSON body to the send-core param type.
    const interactivePayload =
      body.interactive_payload && typeof body.interactive_payload === 'object'
        ? (body.interactive_payload as InteractiveMessagePayload)
        : null;

    validateSendMessageParams({
      messageType: type,
      contentText: typeof body.text === 'string' ? body.text : null,
      mediaUrl: typeof body.media_url === 'string' ? body.media_url : null,
      templateName: typeof template?.name === 'string' ? template.name : null,
      interactivePayload,
    });

    // Transactional: send the template only — no contact, no
    // conversation, nothing stored.
    if (body.transactional === true) {
      if (type !== 'template') {
        return fail('bad_request', "'transactional' is only supported for template messages", 400);
      }
      const sent = await sendTransactionalTemplate(ctx.supabase, ctx.accountId, {
        apiKeyId: ctx.keyId,
        // Codes-only keys may send Authentication-category templates only.
        requireAuthenticationCategory: transactionalOnly,
        to,
        templateName: template!.name as string,
        templateLanguage: typeof template?.language === 'string' ? template.language : null,
        templateParams,
        templateMessageParams,
      });
      return ok({ whatsapp_message_id: sent.whatsappMessageId, transactional: true }, 201);
    }

    // Find-or-create the conversation for this phone, then send. Both
    // steps share `SendMessageError`, so one catch maps the whole
    // pipeline to the envelope.
    const resolved = await resolveConversationByPhone(
      ctx.supabase,
      ctx.accountId,
      to,
      typeof body.name === 'string' ? body.name : null
    );

    const result = await sendMessageToConversation(
      ctx.supabase,
      ctx.accountId,
      {
        conversationId: resolved.conversationId,
        messageType: type,
        contentText: typeof body.text === 'string' ? body.text : null,
        mediaUrl: typeof body.media_url === 'string' ? body.media_url : null,
        filename: typeof body.filename === 'string' ? body.filename : null,
        templateName: typeof template?.name === 'string' ? template.name : null,
        templateLanguage:
          typeof template?.language === 'string' ? template.language : null,
        templateParams,
        templateMessageParams,
        interactivePayload,
        replyToMessageId:
          typeof body.reply_to_message_id === 'string'
            ? body.reply_to_message_id
            : null,
      }
    );

    return ok(
      {
        message_id: result.messageId,
        whatsapp_message_id: result.whatsappMessageId,
        conversation_id: resolved.conversationId,
        contact_id: resolved.contactId,
        contact_created: resolved.contactCreated,
      },
      201
    );
  } catch (err) {
    if (err instanceof SendMessageError) {
      return fail(err.code, err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}
