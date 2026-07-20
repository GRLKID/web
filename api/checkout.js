// Creates a Stripe Checkout Session for one shop item.
//
// Prices are looked up from Supabase by slug and never read from the
// request body -- otherwise anyone could edit the page and buy the
// halter for a dollar. The browser only ever sends slug, size, qty.
//
// Checkout (rather than Elements) is deliberate: it gives Apple Pay and
// Google Pay with no domain-verification file to host, and keeps card
// data off grlkid.com entirely.

const Stripe = require("stripe");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://vzhbtpeafougdvssvhfb.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6aGJ0cGVhZm91Z2R2c3N2aGZiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMzY2ODAsImV4cCI6MjA5OTgxMjY4MH0.nkuFwbUePqO3fTNQ6dBTzGLOg2f0hrpOqwyoIAipMck";

const MAX_QTY = 5;

function bad(res, msg, code) {
  res.status(code || 400).json({ ok: false, error: msg });
}

async function sb(path) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY }
  });
  if (!r.ok) throw new Error("Supabase " + r.status + ": " + (await r.text()));
  return r.json();
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return bad(res, "Method not allowed.", 405);
  }

  const KEY = process.env.STRIPE_SECRET_KEY;
  if (!KEY) return bad(res, "Payments aren't switched on yet.", 503);
  const stripe = new Stripe(KEY);

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { return bad(res, "Malformed request."); }
  }
  body = body || {};

  const slug = String(body.slug || "").trim();
  const size = String(body.size || "").trim();
  const qty = Math.min(Math.max(parseInt(body.qty, 10) || 1, 1), MAX_QTY);
  if (!slug) return bad(res, "No item specified.");

  // ---------- look up the real product ----------
  let product;
  try {
    const rows = await sb("products?slug=eq." + encodeURIComponent(slug) + "&select=*");
    product = rows && rows[0];
  } catch (err) {
    console.error("Product lookup failed:", err);
    return bad(res, "Could not reach the catalogue.", 502);
  }
  if (!product) return bad(res, "That item doesn't exist.", 404);
  if (product.status !== "live") return bad(res, "That item isn't on sale.", 409);
  if (!product.price_cents || product.price_cents < 50) {
    return bad(res, "That item isn't priced yet.", 409);
  }

  // ---------- check stock for the requested size ----------
  let variant;
  try {
    const q = size
      ? "product_variants?product_id=eq." + product.id + "&size=eq." + encodeURIComponent(size)
      : "product_variants?product_id=eq." + product.id + "&size=is.null";
    const rows = await sb(q + "&select=*");
    variant = rows && rows[0];
  } catch (err) {
    console.error("Variant lookup failed:", err);
    return bad(res, "Could not check availability.", 502);
  }
  if (!variant) return bad(res, size ? "That size doesn't exist." : "That item isn't stocked yet.", 404);
  if (variant.stock < qty) {
    return bad(res, variant.stock === 0 ? "That one's sold out." : `Only ${variant.stock} left.`, 409);
  }

  const isPreorder = product.fulfillment === "preorder";
  const shipLine = isPreorder && product.ship_by
    ? "Pre-order — ships on or before " + new Date(product.ship_by + "T00:00:00Z")
        .toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
    : product.tagline || undefined;

  const origin =
    (req.headers["origin"] && String(req.headers["origin"])) ||
    "https://" + (req.headers["x-forwarded-host"] || req.headers["host"] || "grlkid.com");

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        quantity: qty,
        price_data: {
          currency: product.currency || "usd",
          unit_amount: product.price_cents,
          product_data: {
            name: product.name + (size ? " — " + size : ""),
            description: shipLine,
            images: product.image_url ? [product.image_url] : undefined
          }
        }
      }],
      // Physical goods: we need somewhere to send them.
      shipping_address_collection: { allowed_countries: ["US", "CA", "GB", "AU", "IE", "NZ"] },
      billing_address_collection: "auto",
      phone_number_collection: { enabled: false },
      // The webhook reads these back to record the order and decrement stock.
      metadata: { slug: slug, size: size, qty: String(qty) },
      // Stated up front so the pre-order delay is never a surprise -- the FTC
      // mail-order rule turns on what the buyer was told at purchase.
      custom_text: isPreorder && product.ship_by ? {
        submit: { message: shipLine }
      } : undefined,
      success_url: origin + "/shop/thanks?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: origin + "/shop"
    });

    return res.status(200).json({ ok: true, url: session.url });
  } catch (err) {
    console.error("Stripe session failed:", err);
    return bad(res, "Could not start checkout. Please try again.", 502);
  }
};
