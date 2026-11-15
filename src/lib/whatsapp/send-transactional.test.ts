import { afterEach, describe, expect, it, vi } from "vitest";

const { sendTemplateMessage, resolveTemplateRow } = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: "wamid.9" })),
  resolveTemplateRow: vi.fn(async () => ({
    row: { category: "Authentication", body_text: "*{{1}}* is your code.", buttons: null } as unknown,
    malformed: false,
    language: "en",
  })),
}));
vi.mock("@/lib/whatsapp/meta-api", () => ({ sendTemplateMessage }));
vi.mock("@/lib/whatsapp/template-body", () => ({ resolveTemplateRow }));
vi.mock("@/lib/whatsapp/encryption", () => ({ decrypt: (s: string) => `dec(${s})` }));

import { metaErrorCode, sendTransactionalTemplate } from "./send-transactional";

/** Fake db: records tables touched and audit-log inserts. */
function fakeDb(config: Record<string, unknown> | null, insertError: { message: string } | null = null) {
  const touched: string[] = [];
  const inserts: Record<string, unknown>[] = [];
  const db = {
    from(table: string) {
      touched.push(table);
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        single: async () => ({ data: config, error: config ? null : { message: "none" } }),
        insert: async (row: Record<string, unknown>) => {
          inserts.push(row);
          return { error: insertError };
        },
      };
      return q;
    },
  } as unknown as Parameters<typeof sendTransactionalTemplate>[0];
  return { db, touched, inserts };
}
const CONFIG = { phone_number_id: "pn", access_token: "enc" };
const OTP_PARAMS = { body: ["482913"], otp: "482913" };

afterEach(() => {
  sendTemplateMessage.mockClear();
  resolveTemplateRow.mockClear();
});

describe("sendTransactionalTemplate", () => {
  it("sends via Meta without touching contacts, conversations or messages", async () => {
    const { db, touched } = fakeDb(CONFIG);
    const r = await sendTransactionalTemplate(db, "acct", {
      to: "+91 98765 43210", templateName: "curio_verify_code", templateLanguage: "en", templateMessageParams: OTP_PARAMS,
    });
    expect(r.whatsappMessageId).toBe("wamid.9");
    expect([...new Set(touched)].sort()).toEqual(["transactional_message_log", "whatsapp_config"]);
    expect(sendTemplateMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: "919876543210", accessToken: "dec(enc)", templateName: "curio_verify_code", messageParams: OTP_PARAMS,
    }));
  });

  it("writes an audit row with the last 4 digits only, never the code or full number", async () => {
    const { db, inserts } = fakeDb(CONFIG);
    await sendTransactionalTemplate(db, "acct", {
      to: "+919876543210", templateName: "curio_verify_code", templateMessageParams: OTP_PARAMS, apiKeyId: "key-1",
    });
    expect(inserts).toEqual([{
      account_id: "acct", api_key_id: "key-1", template_name: "curio_verify_code", phone_last4: "3210",
      whatsapp_message_id: "wamid.9", status: "sent", error_code: null,
    }]);
    const dump = JSON.stringify(inserts);
    expect(dump).not.toContain("482913");
    expect(dump).not.toContain("9876543210");
  });

  it("logs a failed send with Meta's code only, then 502s", async () => {
    sendTemplateMessage.mockRejectedValueOnce(new Error("(#132000) Number of parameters does not match"));
    const { db, inserts } = fakeDb(CONFIG);
    await expect(sendTransactionalTemplate(db, "acct", {
      to: "919876543210", templateName: "curio_verify_code", templateMessageParams: OTP_PARAMS,
    })).rejects.toMatchObject({ status: 502, code: "meta_error" });
    expect(inserts).toEqual([expect.objectContaining({
      status: "failed", error_code: "132000", whatsapp_message_id: null, phone_last4: "3210",
    })]);
  });

  it("an audit-log failure does not fail the send", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb(CONFIG, { message: "relation does not exist" });
    await expect(sendTransactionalTemplate(db, "acct", { to: "919876543210", templateName: "curio_verify_code" }))
      .resolves.toEqual({ whatsappMessageId: "wamid.9" });
    err.mockRestore();
  });

  it("codes-only keys: rejects non-Authentication templates before sending", async () => {
    resolveTemplateRow.mockResolvedValueOnce({ row: { category: "Utility" } as unknown, malformed: false, language: "en" });
    const { db, inserts } = fakeDb(CONFIG);
    await expect(sendTransactionalTemplate(db, "acct", {
      to: "919876543210", templateName: "curio_verify_code", requireAuthenticationCategory: true,
    })).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it("codes-only keys: rejects a template that isn't synced locally", async () => {
    resolveTemplateRow.mockResolvedValueOnce({ row: null, malformed: false, language: "en" });
    const { db } = fakeDb(CONFIG);
    await expect(sendTransactionalTemplate(db, "acct", {
      to: "919876543210", templateName: "curio_verify_code", requireAuthenticationCategory: true,
    })).rejects.toMatchObject({ status: 403 });
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  it("codes-only keys: allows a synced Authentication template", async () => {
    const { db } = fakeDb(CONFIG);
    await expect(sendTransactionalTemplate(db, "acct", {
      to: "919876543210", templateName: "curio_verify_code", requireAuthenticationCategory: true,
    })).resolves.toEqual({ whatsappMessageId: "wamid.9" });
  });

  it("rejects a bad phone before any lookup", async () => {
    const { db, touched } = fakeDb(CONFIG);
    await expect(sendTransactionalTemplate(db, "acct", { to: "12", templateName: "x" })).rejects.toMatchObject({ status: 400 });
    expect(touched).toEqual([]);
  });
});

describe("metaErrorCode", () => {
  it("extracts Meta's numeric code", () => {
    expect(metaErrorCode("Meta API error: (#131026) Message undeliverable")).toBe("131026");
    expect(metaErrorCode("network down")).toBe("meta_error");
  });
});
