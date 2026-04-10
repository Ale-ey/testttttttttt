const admin = require("firebase-admin");
const path = require("node:path");
const fs = require("node:fs");

// Load .env.local
const dotenvPath = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(dotenvPath)) {
  require("dotenv").config({ path: dotenvPath });
}

function getFirebaseCredentialsFromEnv() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON.trim().replace(/^'|'$/g, "");
      return JSON.parse(raw);
    } catch (err) {
      console.error("Invalid FIREBASE_SERVICE_ACCOUNT_JSON:", err.message);
    }
  }

  if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  ) {
    return {
      project_id: process.env.FIREBASE_PROJECT_ID.trim().replace(/^["']|["']$/g, ""),
      client_email: process.env.FIREBASE_CLIENT_EMAIL.trim().replace(/^["']|["']$/g, ""),
      private_key: process.env.FIREBASE_PRIVATE_KEY
        .trim()
        .replace(/^["']|["']$/g, "")
        .replace(/\\n/g, "\n"),
    };
  }
  return null;
}

const creds = getFirebaseCredentialsFromEnv();
if (!creds) {
  console.error("Firebase credentials missing.");
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(creds) });
const db = admin.firestore();

const CANCELLED_STATUSES = new Set([
  "cancelled",
  "canceled",
  "refunded",
  "rejected",
  "rejected_by_supplier",
  "expired",
]);

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function normalizeBookingKey(body) {
  const raw = body?.booking_key ?? body?.order_id;
  return String(raw ?? "").trim();
}

function getEffectiveQty(body) {
  const rawQty = body?.qty ?? body?.quantity;
  const qty = Math.max(0, toInt(rawQty, 0));
  const qtyCancelled = Math.max(0, toInt(body?.qty_cancelled, 0));
  return Math.max(0, qty - qtyCancelled);
}

function isOccupyingSeat(body) {
  const status = String(body?.status ?? "").trim().toLowerCase();
  if (CANCELLED_STATUSES.has(status)) return false;
  return getEffectiveQty(body) > 0;
}

function normalizeTitle(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function eventDocIdFromPayload(body) {
  const title = normalizeTitle(body?.product_name || body?.ticket_name || "event");
  const dateValue = String(body?.event_date_time ?? "");
  // Modified to handle both 'T' and space
  const match = dateValue.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!match) return `${title}_unknown`;
  const [, year, month, day, hour, minute] = match;
  return `${title}_${year}_${month}_${day}_${hour}_${minute}`;
}

function buildFingerprint(body) {
  return JSON.stringify({
    booking_key: body?.booking_key ?? null,
    status: body?.status ?? null,
    payment_status: body?.payment_status ?? null,
    qty: body?.qty ?? body?.quantity ?? null,
    qty_cancelled: body?.qty_cancelled ?? null,
    ticket_codes: body?.ticket_codes ?? null,
    event_date_time: body?.event_date_time ?? null,
  });
}

function shouldSyncBookingToFirestore(body) {
  const s = String(body?.status ?? "").trim().toLowerCase();
  if (s === "approved" || s === "sent") return true;
  if (CANCELLED_STATUSES.has(s)) return true;
  return false;
}

async function processBooking(booking) {
  const body = booking;
  const bookingKey = normalizeBookingKey(body);
  if (!bookingKey) return;

  if (!shouldSyncBookingToFirestore(body)) return;

  const eventDocId = eventDocIdFromPayload(body);
  const fingerprint = buildFingerprint(body);

  const MOZARTHAUS_APP_DOC = "mozarthaus_new_buchungssystem_mozarthaus_v1";
  const appRoot = db.collection("apps").doc(MOZARTHAUS_APP_DOC);
  const bookingRef = appRoot.collection("bookings").doc(bookingKey);
  const eventRef = appRoot.collection("events").doc(eventDocId);

  try {
    await db.runTransaction(async (tx) => {
      const [bookingSnap, eventSnap] = await Promise.all([
        tx.get(bookingRef),
        tx.get(eventRef),
      ]);

      const previousBooking = bookingSnap.exists ? bookingSnap.data() : null;
      const existingEvent = eventSnap.exists ? eventSnap.data() : {};
      const currentOccupied = Math.max(0, toInt(existingEvent.occupied, 0));

      const nextEffectiveQty = getEffectiveQty(body);
      const nextOccupying = isOccupyingSeat(body);
      const nextSeats = nextOccupying ? nextEffectiveQty : 0;

      const prevApplied = previousBooking != null ? Math.max(0, toInt(previousBooking.seatsAppliedToEvent, 0)) : 0;

      if (previousBooking?.lastFingerprint === fingerprint && currentOccupied > 0 && prevApplied === nextSeats) {
        return;
      }

      const seatDelta = nextSeats - prevApplied;
      const nextOccupied = Math.max(0, currentOccupied + seatDelta);

      const patch = {
        occupied: nextOccupied,
        title: existingEvent.title ?? body.product_name ?? body.ticket_name ?? "",
        status: existingEvent.status ?? "active",
        regiondoId: existingEvent.regiondoId ?? String(body.product_supplier_id ?? body.product_id ?? ""),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      const dateMatch = String(body.event_date_time ?? "").match(/^\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})/);
      if (dateMatch && !existingEvent.time) {
        patch.time = `${dateMatch[1]}:${dateMatch[2]}`;
      }
      if (!existingEvent.date && body.event_date_time) {
        const eventDate = new Date(body.event_date_time.replace(" ", "T"));
        if (!Number.isNaN(eventDate.getTime())) {
          patch.date = admin.firestore.Timestamp.fromDate(eventDate);
        }
      }

      tx.set(eventRef, patch, { merge: true });

      tx.set(
        bookingRef,
        {
          bookingKey,
          eventDocId,
          status: body.status ?? null,
          effectiveQty: nextEffectiveQty,
          isOccupyingSeat: nextOccupying,
          seatsAppliedToEvent: nextSeats,
          seatDeltaApplied: seatDelta,
          lastFingerprint: fingerprint,
          lastReceivedAt: new Date().toISOString(),
          lastPayload: body,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: previousBooking?.createdAt ?? admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });
    return true;
  } catch (err) {
    console.error(`Transaction failed for ${bookingKey}:`, err.message);
    return false;
  }
}

const crypto = require("node:crypto");

const REGIONDO_URL = "https://api.regiondo.com/v1/supplier/bookings";

async function fetchFromRegiondo(params) {
  const publicKey = process.env.REGIONDO_PUBLIC_KEY;
  const privateKey = process.env.REGIONDO_PRIVATE_KEY;

  const timestamp = Math.floor(Date.now() / 1000).toString();

  // Create URLSearchParams to ensure consistent encoding
  const forward = new URLSearchParams();
  // We specify exactly the params the user requested in the correct order
  forward.set("limit", String(params.limit || 100));
  forward.set("offset", String(params.offset || 0));
  forward.set("date_range_by", "date_of_event");
  forward.set("date_range", "2026-04-08,2027-01-31");
  forward.set("status", "sent");
  forward.set("store_locale", "de-AT");

  const queryString = forward.toString();
  const stringToHash = timestamp + publicKey + queryString;

  const hash = crypto
    .createHmac("sha256", privateKey)
    .update(stringToHash)
    .digest("hex");

  const fullUrl = `${REGIONDO_URL}?${queryString}`;
  console.log(`Calling Regiondo API: ${fullUrl}`);

  const res = await fetch(fullUrl, {
    headers: {
      "X-API-ID": publicKey,
      "X-API-TIME": timestamp,
      "X-API-HASH": hash,
      "Accept": "application/json",
      "User-Agent": "Mozarthaus-Regiondo-Sync/1.0"
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Regiondo API error ${res.status}: ${text.slice(0, 200)}`);
  }

  return await res.json();
}

async function runSync() {
  const limit = 100;
  let offset = 0;
  let totalItems = 0;
  let processed = 0;
  let failed = 0;

  console.log("Starting sync...");

  try {
    do {
      const params = {
        limit,
        offset,
        date_range_by: "date_of_event",
        date_range: "2026-04-08,2027-01-31",
        status: "sent",
        store_locale: "de-AT"
      };

      let json;
      try {
        // Try local proxy first
        const proxyUrl = `http://localhost:5173/api/regiondo/supplier/bookings?limit=${limit}&offset=${offset}&date_range_by=date_of_event&date_range=2026-04-08,2027-01-31&status=sent&store_locale=de-AT`;
        console.log(`Fetching from proxy: offset ${offset}...`);
        const res = await fetch(proxyUrl);
        const text = await res.text();
        if (res.ok && !text.trim().startsWith("<!doctype")) {
          json = JSON.parse(text);
          console.log("Proxy OK");
        } else {
          console.log("Proxy failed or returned HTML, falling back to direct API...");
          json = await fetchFromRegiondo(params);
        }
      } catch (err) {
        console.log(`Proxy fetch failed: ${err.message}, falling back to direct API...`);
        json = await fetchFromRegiondo(params);
      }

      totalItems = json.page.total_items;
      const bookings = json.data;

      if (!bookings || bookings.length === 0) break;

      for (const booking of bookings) {
        const success = await processBooking(booking);
        if (success) processed++;
        else failed++;
        
        if ((processed + failed) % 10 === 0) {
          console.log(`Progress: ${processed + failed}/${totalItems}`);
        }
      }

      offset += limit;
    } while (offset < totalItems);

    console.log(`Sync complete. Total: ${totalItems}, Processed: ${processed}, Failed: ${failed}`);
  } catch (err) {
    console.error("Sync failed:", err.message);
  }
  process.exit(0);
}

runSync();
