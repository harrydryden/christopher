/**
 * Outbound email for verification and password-reset links. Uses Resend's HTTP API when
 * RESEND_API_KEY and EMAIL_FROM are set; otherwise nothing is sent. Outside production, or when
 * AUTH_EMAIL_LOG=1, an unsent message is written to the server log so the link can be used.
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
    if (process.env.NODE_ENV !== "production" || process.env.AUTH_EMAIL_LOG === "1") {
      console.info(JSON.stringify({ event: "email_not_configured", to: mail.to, subject: mail.subject, text: mail.text }));
    } else {
      console.info(JSON.stringify({ event: "email_not_configured", to: mail.to, subject: mail.subject }));
    }
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
