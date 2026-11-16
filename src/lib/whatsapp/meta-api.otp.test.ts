import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendTemplateMessage } from "./meta-api";
import type { MessageTemplate } from "@/types";

type Sent = { template: { components: { parameters: { text: string }[] }[] } };
let sent = null as unknown as Sent;
beforeEach(() => {
  sent = null as unknown as Sent;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body)) as Sent;
    return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const BASE = { phoneNumberId: "p", accessToken: "t", to: "919876543210", templateName: "curio_verify_code", language: "en" };
// Auth template row as stored after sync: body with {{1}}, OTP button dropped.
const authRow = { body_text: "*{{1}}* is your verification code.", buttons: null, header_type: null } as unknown as MessageTemplate;
const otpButton = { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "482913" }] };

describe("sendTemplateMessage — authentication otp", () => {
  it("adds body {{1}} and the OTP url button from the template row", async () => {
    await sendTemplateMessage({ ...BASE, template: authRow, messageParams: { otp: "482913" } });
    expect(sent.template.components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "482913" }] },
      otpButton,
    ]);
  });

  it("works without a template row", async () => {
    await sendTemplateMessage({ ...BASE, messageParams: { otp: "482913" } });
    expect(sent.template.components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "482913" }] },
      otpButton,
    ]);
  });

  it("keeps explicit body values", async () => {
    await sendTemplateMessage({ ...BASE, messageParams: { body: ["482913"], otp: "482913" } });
    expect(sent.template.components[0].parameters[0].text).toBe("482913");
    expect(sent.template.components).toHaveLength(2);
  });

  it("fills the synced OTP url button once (row stored with the button)", async () => {
    // Meta lists the copy-code button as a URL button ending in {{1}};
    // "Sync from Meta" stores it that way.
    const syncedRow = {
      ...authRow,
      buttons: [{ type: "URL", text: "Copy code", url: "https://www.whatsapp.com/otp/code/?otp_type=COPY_CODE&code=otp{{1}}" }],
    } as unknown as MessageTemplate;
    await sendTemplateMessage({ ...BASE, template: syncedRow, messageParams: { otp: "482913" } });
    expect(sent.template.components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "482913" }] },
      otpButton,
    ]);
  });

  it("leaves non-otp sends unchanged", async () => {
    await sendTemplateMessage({ ...BASE, params: ["A123"] });
    expect(sent.template.components).toEqual([{ type: "body", parameters: [{ type: "text", text: "A123" }] }]);
  });
});
