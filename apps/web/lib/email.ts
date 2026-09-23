/**
 * Outbound email for confirmation and password-reset links. Uses Resend's HTTP API when
 * RESEND_API_KEY and EMAIL_FROM are set. Without a provider the server log is the only place a
 * link can go. Outside production the full message is logged there unless AUTH_EMAIL_LOG=0. In
 * production it is logged only with AUTH_EMAIL_LOG=1: the reset form is public, so a live reset
 * link in the log is an account takeover, an administrator's included, for anyone who can read the
 * log or a drain it feeds. Admin › Accounts mints reset links for that case instead.
 */
export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
}

export function emailConfigured(): boolean {
  return !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

/** Whether a message that cannot be sent is written to the log in full, links and all. */
export function emailTextLogged(): boolean {
  return process.env.NODE_ENV === "production" ? process.env.AUTH_EMAIL_LOG === "1" : process.env.AUTH_EMAIL_LOG !== "0";
}

export async function sendEmail(mail: OutboundEmail): Promise<{ delivered: boolean }> {
  if (!emailConfigured()) {
    const includeText = emailTextLogged();
    const line = JSON.stringify({ event: "email_not_configured", to: mail.to, subject: mail.subject, ...(includeText ? { text: mail.text } : {}) });
    // A message that went nowhere at all is worth a warning: nobody will receive that link.
    if (includeText) console.info(line);
    else console.warn(line);
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
