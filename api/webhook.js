// Stripe webhook -- the only thing that may mark an order as paid.
//
// The browser redirect after checkout is NOT proof of payment: the
// customer can close the tab, lose signal, or hit the success URL
// directly. Stripe calling this endpoint is the real signal, which is
// why the order row and the stock decrement live here and nowhere else.
//
// Signature verification needs the raw request body byte-for-byte, so
// body parsing is disabled below and the stream is buffered by hand.

const Stripe = require("stripe");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://vzhbtpeafougdvssvhfb.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6aGJ0cGVhZm91Z2R2c3N2aGZiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMzY2ODAsImV4cCI6MjA5OTgxMjY4MH0.nkuFwbUePqO3fTNQ6dBTzGLOg2f0hrpOqwyoIAipMck";

const RESEND_KEY =
  process.env.RESEND_API_KEY ||
  process.env.Resend_API_key ||
  process.env.RESEND_API_key;
const FROM = process.env.NOTIFY_FROM || "GRLKID <notifications@grlkid.com>";
const NOTIFY_TO = process.env.NOTIFY_EMAIL || "info@grlkid.com";

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function money(cents, currency) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency", currency: (currency || "usd").toUpperCase()
  });
}

function rawBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    req.on("data", function (c) { chunks.push(c); });
    req.on("end", function () { resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).end();
  }

  const KEY = process.env.STRIPE_SECRET_KEY;
  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  if (!KEY || !WEBHOOK_SECRET) {
    console.error("Stripe env vars missing.");
    return res.status(503).end();
  }
  const stripe = new Stripe(KEY);

  // ---------- verify it really came from Stripe ----------
  let event;
  try {
    const buf = await rawBody(req);
    event = stripe.webhooks.constructEvent(buf, req.headers["stripe-signature"], WEBHOOK_SECRET);
  } catch (err) {
    console.error("Signature verification failed:", err.message);
    return res.status(400).send("Invalid signature");
  }

  if (event.type !== "checkout.session.completed") {
    return res.status(200).json({ received: true, ignored: event.type });
  }

  const session = event.data.object;
  if (session.payment_status !== "paid") {
    return res.status(200).json({ received: true, unpaid: true });
  }

  const md = session.metadata || {};
  const items = [{
    slug: md.slug || null,
    size: md.size || null,
    qty: parseInt(md.qty, 10) || 1
  }];
  const email = (session.customer_details && session.customer_details.email) || null;
  const shipping =
    (session.collected_information && session.collected_information.shipping_details) ||
    session.shipping_details ||
    null;

  // ---------- record it (idempotent -- Stripe retries) ----------
  let isNew = false;
  try {
    const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/record_paid_order", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: "Bearer " + SUPABASE_KEY
      },
      body: JSON.stringify({
        p_session_id: session.id,
        p_payment_intent: session.payment_intent || null,
        p_email: email,
        p_amount: session.amount_total,
        p_currency: session.currency,
        p_items: items,
        p_shipping: shipping
      })
    });
    if (!r.ok) {
      // Return non-2xx so Stripe retries rather than dropping a paid order.
      console.error("record_paid_order failed:", r.status, await r.text());
      return res.status(500).send("Could not record order");
    }
    isNew = (await r.json()) === true;
  } catch (err) {
    console.error("record_paid_order error:", err);
    return res.status(500).send("Could not record order");
  }

  if (!isNew) {
    return res.status(200).json({ received: true, duplicate: true });
  }

  // ---------- notify (best-effort; never fail the webhook on email) ----------
  if (RESEND_KEY) {
    const line = esc(md.slug) + (md.size ? " — " + esc(md.size) : "") + " × " + items[0].qty;
    const addr = shipping && shipping.address
      ? [shipping.name, shipping.address.line1, shipping.address.line2,
         shipping.address.city, shipping.address.state, shipping.address.postal_code,
         shipping.address.country].filter(Boolean).map(esc).join("<br>")
      : "No address collected";

    const send = (to, subject, html) =>
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + RESEND_KEY },
        body: JSON.stringify({ from: FROM, to: [to], subject: subject, html: html })
      });

    try {
      await send(NOTIFY_TO, "New order — " + line,
        '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.6;color:#0e0e0e">' +
        "<h2 style=\"font-weight:500\">New order</h2>" +
        "<p><strong>" + line + "</strong><br>" +
        money(session.amount_total, session.currency) + "</p>" +
        "<p><strong>Buyer:</strong> " + esc(email || "unknown") + "</p>" +
        "<p><strong>Ship to</strong><br>" + addr + "</p>" +
        "<p style=\"color:#6d6a63;font-size:13px\">Session " + esc(session.id) + "</p></div>");

      if (email) {
        await send(email, "Your GRLKID order",
          '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.6;color:#0e0e0e">' +
          "<p>Thanks — your order is confirmed.</p>" +
          "<p><strong>" + line + "</strong><br>" +
          money(session.amount_total, session.currency) + "</p>" +
          "<p>We'll email you again when it ships. Any questions, just reply to this.</p>" +
          "<p>— GRLKID</p></div>");
      }
    } catch (err) {
      console.error("Order email failed:", err);
    }
  }

  return res.status(200).json({ received: true, recorded: true });
}

module.exports = handler;
// Stripe signs the raw bytes; a parsed-and-restringified body won't match.
module.exports.config = { api: { bodyParser: false } };
