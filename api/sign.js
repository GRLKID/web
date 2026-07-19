// GRLKID contributor-license signing — Vercel serverless function.
// Stores the signed license in the Supabase `license_signatures` table
// (RLS insert-only: this key can add rows, never read them) and emails a
// copy to GRLKID and to the signer.
//
// Email is optional: if RESEND_API_KEY isn't set the signature is still
// recorded and the signer still gets a success response — the notification
// simply no-ops. Add the key in Vercel to switch email on.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LICENSE_VERSION = "issue-001-v1";
const NOTIFY_TO = process.env.NOTIFY_EMAIL || "info@grlkid.com";

function bad(res, msg, code) {
  res.status(code || 400).json({ ok: false, error: msg });
}

function esc(s) {
  return String(s || "").replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return bad(res, "Method not allowed.", 405);
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || "https://vzhbtpeafougdvssvhfb.supabase.co";
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6aGJ0cGVhZm91Z2R2c3N2aGZiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMzY2ODAsImV4cCI6MjA5OTgxMjY4MH0.nkuFwbUePqO3fTNQ6dBTzGLOg2f0hrpOqwyoIAipMck";
  if (!SUPABASE_URL || !SUPABASE_KEY) return bad(res, "Server not configured.", 500);

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { return bad(res, "Malformed request."); }
  }
  body = body || {};

  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const work = String(body.work || "").trim();
  const initials = String(body.initials || "").trim().toUpperCase();
  const signature = String(body.signature || "");
  const agreedTerms = body.agreed_terms === true;
  const agreedEsign = body.agreed_electronic === true;

  if (!name) return bad(res, "Your name is required.");
  if (!EMAIL_RE.test(email)) return bad(res, "A valid email is required.");
  if (!work) return bad(res, "A description of the work is required.");
  if (!initials) return bad(res, "Initials are required.");
  if (!signature.startsWith("data:image/png;base64,")) return bad(res, "A signature is required.");
  if (signature.length > 800000) return bad(res, "Signature image is too large.");
  if (!agreedTerms || !agreedEsign) return bad(res, "Both agreements must be checked.");

  // audit trail
  const fwd = req.headers["x-forwarded-for"] || "";
  const ip = String(fwd).split(",")[0].trim() || null;
  const userAgent = String(body.user_agent || req.headers["user-agent"] || "").slice(0, 500);
  const signedAt = new Date().toISOString();

  const cap = (s, n) => s.slice(0, n);
  const row = {
    signer_name: cap(name, 200),
    signer_email: cap(email, 320),
    work_description: cap(work, 2000),
    initials: cap(initials, 6),
    signature_png: signature,
    agreed_terms: true,
    agreed_electronic: true,
    license_version: LICENSE_VERSION,
    user_agent: userAgent,
    ip_address: ip
  };

  // ---------- 1. record it ----------
  try {
    const resp = await fetch(SUPABASE_URL + "/rest/v1/license_signatures", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: "Bearer " + SUPABASE_KEY,
        Prefer: "return=minimal"
      },
      body: JSON.stringify(row)
    });
    if (!(resp.status === 201 || resp.status === 200 || resp.status === 204)) {
      const text = await resp.text();
      console.error("Supabase insert failed:", resp.status, text);
      return bad(res, "Could not record your signature. Please try again.", 502);
    }
  } catch (err) {
    console.error("Insert error:", err);
    return bad(res, "Could not record your signature. Please try again.", 500);
  }

  // ---------- 2. notify (best-effort) ----------
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.NOTIFY_FROM || "GRLKID <notifications@grlkid.com>";
  let emailed = false;

  if (RESEND_KEY) {
    const b64 = signature.split(",")[1];
    const summary =
      '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.6;color:#0e0e0e">' +
      "<h2 style=\"font-weight:500\">Contributor License signed — Issue 001</h2>" +
      "<p><strong>Name:</strong> " + esc(name) + "<br>" +
      "<strong>Email:</strong> " + esc(email) + "<br>" +
      "<strong>Initials:</strong> " + esc(initials) + "<br>" +
      "<strong>Work:</strong> " + esc(work) + "</p>" +
      "<p style=\"color:#6d6a63;font-size:13px\"><strong>Audit trail</strong><br>" +
      "Signed at: " + esc(signedAt) + "<br>" +
      "License version: " + esc(LICENSE_VERSION) + "<br>" +
      "IP: " + esc(ip || "unknown") + "<br>" +
      "User agent: " + esc(userAgent) + "</p>" +
      "<p>Signature image attached.</p></div>";

    const send = (to, subject, html) =>
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + RESEND_KEY },
        body: JSON.stringify({
          from: FROM,
          to: [to],
          subject: subject,
          html: html,
          attachments: [{ filename: "signature-" + initials + ".png", content: b64 }]
        })
      });

    try {
      const r1 = await send(NOTIFY_TO, "Signed — " + name + " (Issue 001 license)", summary);
      emailed = r1.ok;
      if (!r1.ok) console.error("Resend (internal) failed:", r1.status, await r1.text());

      // courtesy copy to the signer
      const copy =
        '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.6;color:#0e0e0e">' +
        "<p>Hi " + esc(name) + ",</p>" +
        "<p>Thanks for signing the GRLKID Contributor License for Issue 001. This is your copy for the record.</p>" +
        "<p><strong>Work:</strong> " + esc(work) + "<br><strong>Signed at:</strong> " + esc(signedAt) + "</p>" +
        "<p>A reminder of what it says: you keep ownership of your work, the licence is non-exclusive, " +
        "and any commercial or brand use needs your separate permission and payment. You can withdraw the " +
        "work from the app at any time by writing to " + esc(NOTIFY_TO) + ".</p>" +
        "<p>— GRLKID</p></div>";
      const r2 = await send(email, "Your GRLKID Contributor License (Issue 001)", copy);
      if (!r2.ok) console.error("Resend (signer copy) failed:", r2.status, await r2.text());
    } catch (err) {
      console.error("Email error:", err);
    }
  }

  return res.status(200).json({ ok: true, emailed: emailed });
};
