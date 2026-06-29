const RESEND_API = 'https://api.resend.com/emails';

export async function sendOTPEmail(env, { to, code, siteName }) {
  const res = await fetch(RESEND_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Scribe-It <noreply@scribe-it.app>',
      to: [to],
      subject: `Your ${siteName} sign-in code: ${code}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:2rem">
          <h2 style="color:#2e7d52">Sign in to ${siteName}</h2>
          <p>Enter this code to access the writing tool:</p>
          <div style="font-size:2.5rem;font-weight:700;letter-spacing:0.3rem;color:#1f2937;
                      background:#f3f4f6;padding:1.25rem;border-radius:8px;text-align:center;
                      margin:1.5rem 0">${code}</div>
          <p style="color:#6b7280;font-size:0.9rem">This code expires in 5 minutes.
          If you didn't request this, you can safely ignore this email.</p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:1.5rem 0">
          <p style="color:#9ca3af;font-size:0.8rem">Scribe-It — AI-assisted blogging</p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend API error ${res.status}: ${err}`);
  }
}
