/**
 * Outbound email for confirmation and password-reset links. Uses Resend's HTTP API when
 * RESEND_API_KEY and EMAIL_FROM are set. Without a provider the server log is the only place a
 * link can go, so the full message is logged there unless AUTH_EMAIL_LOG=0.
 */
export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
}

export function emailConfigured(): boolean {
  return !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

export async function sendEmail(mail: OutboundEmail): Promise<{ delivered: boolean }> {
  if (!emailConfigured()) {
    const includeText = process.env.AUTH_EMAIL_LOG !== "0";
    console.info(JSON.stringify({ event: "email_not_configured", to: mail.to, subject: mail.subject, ...(includeText ? { text: mail.text } : {}) }));
    return { delivered: false };
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text }),
    });
    if (!response.ok) {
      console.error(JSON.stringify({ event: "email_send_failed", status: response.status, subject: mail.subject }));
      return { delivered: false };
    }
    return { delivered: true };
  } catch (error) {
    console.error(JSON.stringify({ event: "email_send_failed", error: error instanceof Error ? error.message : String(error) }));
    return { delivered: false };
  }
}
