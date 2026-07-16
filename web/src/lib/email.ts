/**
 * Outbound email, currently only for password resets. Uses the Resend API
 * when RESEND_API_KEY is set; otherwise reports "not configured" and the
 * caller falls back to admin-mediated reset links (Users screen).
 */

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

export async function sendResetEmail(to: string, link: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const from = process.env.EMAIL_FROM || "Home <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to,
        subject: "Reset your Home password",
        text:
          `A password reset was requested for your Home account.\n\n` +
          `Reset it here (link expires in 1 hour):\n${link}\n\n` +
          `If you didn't request this, you can ignore this email.`,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
