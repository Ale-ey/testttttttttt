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
      return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
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
      project_id: process.env.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    };
  }

  return null;
}

const creds = getFirebaseCredentialsFromEnv();
if (!creds) {
  console.error("No credentials found in environment.");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(creds),
});

const db = admin.firestore();

// --- Logic from server.js (to be tested/refined) ---

const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "refunded", "rejected"]);

function normalizeRegiondoBody(raw) {
  if (raw == null) return {};
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch { return {}; }
  }
  let merged = { ...obj };
  if (obj.body != null && typeof obj.body === "object" && !Array.isArray(obj.body)) {
    merged = { ...merged, ...obj.body };
  }
  return merged;
}

function toInt(value, fallback = 0) {
  const parsed = parseInt(String(value ?? ""), 10);
  return isNaN(parsed) ? fallback : parsed;
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
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function eventDocIdFromPayload(body) {
  const title = normalizeTitle(body?.product_name || body?.ticket_name || "event");
  const dateValue = String(body?.event_date_time ?? "");
  const match = dateValue.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return `${title}_unknown`;
  const [, year, month, day, hour, minute] = match;
  return `${title}_${year}_${month}_${day}_${hour}_${minute}`;
}

async function simulateWebhook(payload) {
  const body = normalizeRegiondoBody(payload.body);
  const bookingKey = body.booking_key || body.order_id;
  if (!bookingKey) {
    console.log("SKIP: No bookingKey");
    return;
  }

  const eventDocId = eventDocIdFromPayload(body);
  const APP_PATH = "apps/mozarthaus_new_buchungssystem_mozarthaus_v1";
  const bookingRef = db.collection(`${APP_PATH}/test_bookings`).doc(bookingKey);
  const eventRef = db.collection(`${APP_PATH}/test_events`).doc(eventDocId);

  console.log(`\n--- Processing Booking: ${bookingKey} ---`);
  
  try {
    await db.runTransaction(async (tx) => {
      const [bookingSnap, eventSnap] = await Promise.all([
        tx.get(bookingRef),
        tx.get(eventRef),
      ]);

      const previousBooking = bookingSnap.exists ? bookingSnap.data() : null;
      const existingEvent = eventSnap.exists ? eventSnap.data() : {};
      const currentOccupied = toInt(existingEvent.occupied, 0);

      const nextEffectiveQty = getEffectiveQty(body);
      const nextOccupying = isOccupyingSeat(body);
      const nextSeats = nextOccupying ? nextEffectiveQty : 0;

      const prevSeats = previousBooking ? toInt(previousBooking.seatsAppliedToEvent, 0) : 0;
      const seatDelta = nextSeats - prevSeats;

      const nextOccupied = Math.max(0, currentOccupied + seatDelta);

      console.log(`Status: ${body.status}, NextSeats: ${nextSeats}, PrevSeats: ${prevSeats}, Delta: ${seatDelta}, NextOccupied: ${nextOccupied}`);

      tx.set(eventRef, {
        occupied: nextOccupied,
        title: body.product_name || existingEvent.title || "Test Event",
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      tx.set(bookingRef, {
        bookingKey,
        eventDocId,
        status: body.status,
        effectiveQty: nextEffectiveQty,
        seatsAppliedToEvent: nextSeats,
        lastPayload: body,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });
    console.log("Transaction OK");
  } catch (err) {
    console.error("Transaction FAILED:", err);
  }
}

async function runTest() {
  const testData = {
    body: {
      booking_key: "test-booking-123",
      product_name: "Test Concert",
      event_date_time: "2026-05-10T19:00:00+02:00",
      qty: "2",
      status: "approved"
    }
  };

  console.log("Test 1: New Booking (qty 2)");
  await simulateWebhook(testData);

  console.log("\nTest 2: Update same booking (qty 3)");
  testData.body.qty = "3";
  await simulateWebhook(testData);

  console.log("\nTest 3: Cancel booking");
  testData.body.status = "canceled";
  await simulateWebhook(testData);

  console.log("\nTest 4: Re-approve booking (qty 1)");
  testData.body.status = "approved";
  testData.body.qty = "1";
  await simulateWebhook(testData);

  process.exit(0);
}

runTest();
