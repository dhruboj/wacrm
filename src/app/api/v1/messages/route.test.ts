import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  scopes: [] as string[],
  requireApiKey: vi.fn(),
  resolveConversationByPhone: vi.fn(),
  sendMessageToConversation: vi.fn(),
  sendTransactionalTemplate: vi.fn(),
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
  },
}));
vi.mock('@/lib/auth/api-context', () => ({ requireApiKey: h.requireApiKey }));
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationByPhone: h.resolveConversationByPhone,
}));
vi.mock('@/lib/whatsapp/send-message', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/send-message')>()),
  sendMessageToConversation: h.sendMessageToConversation,
}));
vi.mock('@/lib/whatsapp/send-transactional', () => ({
  sendTransactionalTemplate: h.sendTransactionalTemplate,
}));

import { POST } from './route';

const req = (body: unknown) =>
  new Request('http://x/api/v1/messages', { method: 'POST', body: JSON.stringify(body) });
const otpBody = {
  to: '+919876543210',
  type: 'template',
  transactional: true,
  template: { name: 'curio_verify_code', language: 'en', params: { body: ['482913'], otp: '482913' } },
};
type Res = {
  body: { data?: Record<string, unknown>; error?: { code: string; message: string } };
  status: number;
};
const post = async (body: unknown) => (await POST(req(body))) as unknown as Res;

beforeEach(() => {
  vi.clearAllMocks();
  h.requireApiKey.mockImplementation(async () => ({
    supabase: {}, accountId: 'acc', keyId: 'key-1', scopes: h.scopes, createdBy: null,
  }));
  h.resolveConversationByPhone.mockResolvedValue({ conversationId: 'conv', contactId: 'ct', contactCreated: false });
  h.sendMessageToConversation.mockResolvedValue({ messageId: 'm1', whatsappMessageId: 'wamid.A' });
  h.sendTransactionalTemplate.mockResolvedValue({ whatsappMessageId: 'wamid.T' });
});

describe('POST /api/v1/messages — messages:send keys (unchanged)', () => {
  beforeEach(() => {
    h.scopes = ['messages:send'];
  });

  it('a normal template send still resolves the contact and stores the message', async () => {
    const res = await post({
      to: '+919876543210', type: 'template',
      template: { name: 'payment_received', language: 'en', params: ['A1'] },
    });
    expect(res.status).toBe(201);
    expect(h.resolveConversationByPhone).toHaveBeenCalledOnce();
    expect(h.sendMessageToConversation).toHaveBeenCalledWith(
      {}, 'acc', expect.objectContaining({ templateName: 'payment_received', templateParams: ['A1'] }),
    );
    expect(h.sendTransactionalTemplate).not.toHaveBeenCalled();
    expect(res.body.data).toMatchObject({ whatsapp_message_id: 'wamid.A', contact_id: 'ct' });
  });

  it('text sends still work', async () => {
    const res = await post({ to: '+919876543210', text: 'hi' });
    expect(res.status).toBe(201);
    expect(h.sendMessageToConversation).toHaveBeenCalledOnce();
  });

  it('may send transactionally, without the Authentication-only restriction', async () => {
    const res = await post(otpBody);
    expect(res.status).toBe(201);
    expect(h.sendTransactionalTemplate).toHaveBeenCalledWith(
      {}, 'acc', expect.objectContaining({ apiKeyId: 'key-1', requireAuthenticationCategory: false }),
    );
    expect(h.resolveConversationByPhone).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/messages — messages:send_transactional keys', () => {
  beforeEach(() => {
    h.scopes = ['messages:send_transactional'];
  });

  it('sends an allow-listed template transactionally, Authentication-only', async () => {
    const res = await post(otpBody);
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ whatsapp_message_id: 'wamid.T', transactional: true });
    expect(h.sendTransactionalTemplate).toHaveBeenCalledWith({}, 'acc', expect.objectContaining({
      to: '+919876543210',
      templateName: 'curio_verify_code',
      requireAuthenticationCategory: true,
      templateMessageParams: { body: ['482913'], otp: '482913' },
    }));
    expect(h.resolveConversationByPhone).not.toHaveBeenCalled();
    expect(h.sendMessageToConversation).not.toHaveBeenCalled();
  });

  it.each([
    ['a text message', { to: '+919876543210', text: 'hi' }],
    ['a non-transactional template', { ...otpBody, transactional: undefined }],
    ['another template', { ...otpBody, template: { ...otpBody.template, name: 'payment_received' } }],
    ['a media message', { to: '+919876543210', type: 'image', media_url: 'https://x/y.png', transactional: true }],
  ])('rejects %s with 403 and sends nothing', async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('forbidden');
    expect(h.sendTransactionalTemplate).not.toHaveBeenCalled();
    expect(h.sendMessageToConversation).not.toHaveBeenCalled();
    expect(h.resolveConversationByPhone).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/messages — keys with neither scope', () => {
  it('rejects with 403', async () => {
    h.scopes = ['contacts:read'];
    const res = await post(otpBody);
    expect(res.status).toBe(403);
    expect(h.sendTransactionalTemplate).not.toHaveBeenCalled();
  });
});
