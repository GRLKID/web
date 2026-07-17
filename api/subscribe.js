// GRLKID waitlist intake — Vercel serverless function.
// Validates the submission and inserts it into the Supabase `waitlist` table.
// Runs server-side only (its source is never served to visitors). The table
// has RLS with an insert-only policy, so the key used here can only add rows.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function bad(res, msg, code) {
  res.status(code || 400).json({ ok: false, error: msg });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return bad(res, "Method not allowed.", 405);
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || "https://vzhbtpeafougdvssvhfb.supabase.co";
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6aGJ0cGVhZm91Z2R2c3N2aGZiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMzY2ODAsImV4cCI6MjA5OTgxMjY4MH0.nkuFwbUePqO3fTNQ6dBTzGLOg2f0hrpOqwyoIAipMck";
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return bad(res, "Server not configured.", 500);
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { return bad(res, "Malformed request."); }
  }
  body = body || {};

  const name = String(body.name || "").trim();
  const creatorType = String(body.creator_type || "").trim();
  let creatorTypeOther = String(body.creator_type_other || "").trim();
  const workLink = String(body.work_link || "").trim();
  const phone = String(body.phone || "").trim();
  const email = String(body.email || "").trim().toLowerCase();

  if (!name) return bad(res, "Name is required.");
  if (!creatorType) return bad(res, "Discipline is required.");
  if (creatorType === "Other" && !creatorTypeOther) return bad(res, "Specify your discipline.");
  if (creatorType !== "Other") creatorTypeOther = "";
  if (!workLink) return bad(res, "A work link is required.");
  if ((phone.match(/\d/g) || []).length < 7) return bad(res, "A valid phone number is required.");
  if (!EMAIL_RE.test(email)) return bad(res, "A valid email is required.");

  const cap = (s, n) => s.slice(0, n);
  const row = {
    name: cap(name, 200),
    creator_type: cap(creatorType, 80),
    creator_type_other: creatorTypeOther ? cap(creatorTypeOther, 120) : null,
    work_link: cap(workLink, 500),
    phone: cap(phone, 60),
    email: cap(email, 320),
    source: "landing"
  };

  try {
    const resp = await fetch(SUPABASE_URL + "/rest/v1/waitlist", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Prefer": "return=minimal"
      },
      body: JSON.stringify(row)
    });
    if (resp.status === 201 || resp.status === 200 || resp.status === 204) {
      return res.status(200).json({ ok: true });
    }
    const text = await resp.text();
    if (resp.status === 409 || text.indexOf("23505") !== -1 || text.toLowerCase().indexOf("duplicate") !== -1) {
      return res.status(200).json({ ok: true, duplicate: true });
    }
    console.error("Supabase insert failed:", resp.status, text);
    return bad(res, "Could not file your entry. Please try again.", 502);
  } catch (err) {
    console.error("Insert error:", err);
    return bad(res, "Could not file your entry. Please try again.", 500);
  }
};
