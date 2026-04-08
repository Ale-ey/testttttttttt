const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const admin = require("firebase-admin");

const dotenvPath = path.join(__dirname, ".env.local");
if (fs.existsSync(dotenvPath)) {
  require("dotenv").config({ path: dotenvPath });
}

const app = express();
const PORT = process.env.PORT || 3000;

// Behind ngrok / a reverse proxy so req.ip and secure cookies behave correctly when deployed.
app.set("trust proxy", 1);

const MAX_HISTORY = 100;
const webhookHistory = [];
/** @type {Set<import("http").ServerResponse>} */
const sseClients = new Set();
let webhookQueue = Promise.resolve();

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

function initFirestore() {
  try {
    if (!admin.apps.length) {
      const creds = getFirebaseCredentialsFromEnv();
      if (creds) {
        admin.initializeApp({ credential: admin.credential.cert(creds) });
      } else {
        console.warn(
          "Firebase credentials missing. Set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY."
        );
        return null;
      }
    }
    return admin.firestore();
  } catch (err) {
    console.error("Failed to initialize Firebase Admin:", err);
    return null;
  }
}

const db = initFirestore();

function getFirebaseProjectId() {
  try {
    const id = admin.app()?.options?.projectId;
    if (id) return id;
  } catch {
    /* no app */
  }
  return process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || null;
}

const CANCELLED_STATUSES = new Set([
  "cancelled",
  "canceled",
  "refunded",
  "rejected",
  "rejected_by_supplier",
  "expired",
]);

/** Set WEBHOOK_DEBUG=0 to silence Firestore step logs in production. */
function webhookDebugEnabled() {
  return process.env.WEBHOOK_DEBUG !== "0";
}

function logFs(step, detail) {
  if (!webhookDebugEnabled()) return;
  if (detail !== undefined) {
    console.log(`[webhook→firestore] ${step}`, detail);
  } else {
    console.log(`[webhook→firestore] ${step}`);
  }
}

function broadcastToBrowsers(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(line);
    } catch {
      sseClients.delete(res);
    }
  }
}

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function normalizeBookingKey(body) {
  const raw = body?.booking_key ?? body?.order_id;
  return String(raw ?? "").trim();
}

/** Regiondo / proxies may send JSON as a string or wrap fields under `body`. */
function normalizeRegiondoBody(raw) {
  if (raw == null) return {};
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (typeof obj !== "object" || Array.isArray(obj)) return {};
  let merged = { ...obj };
  if (obj.body != null && typeof obj.body === "object" && !Array.isArray(obj.body)) {
    merged = { ...merged, ...obj.body };
  }
  if (obj.data != null && typeof obj.data === "object" && !Array.isArray(obj.data)) {
    merged = { ...merged, ...obj.data };
  }
  return merged;
}

function getEffectiveQty(body) {
  const rawQty = body?.qty ?? body?.quantity;
  const qty = Math.max(0, toInt(rawQty, 0));
  const qtyCancelled = Math.max(0, toInt(body?.qty_cancelled, 0));
  return Math.max(0, qty - qtyCancelled);
}

function isOccupyingSeat(body) {
  const status = String(body?.status ?? "")
    .trim()
    .toLowerCase();
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
  const match = dateValue.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
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

async function processWebhookToFirestore(payload) {
  logFs("01 start", { hasDb: Boolean(db) });
  if (!db) {
    console.warn("[webhook→firestore] ABORT: Firestore not initialized (check Admin env vars).");
    return;
  }

  const body = normalizeRegiondoBody(payload.body);
  logFs("02 body normalized", {
    booking_key: body?.booking_key,
    status: body?.status,
    qty: body?.qty,
    qty_cancelled: body?.qty_cancelled,
    event_date_time: body?.event_date_time,
  });

  const bookingKey = normalizeBookingKey(body);
  if (!bookingKey) {
    console.warn("[webhook→firestore] ABORT: booking_key missing after normalize.");
    return;
  }

  const eventDocId = eventDocIdFromPayload(body);
  const fingerprint = buildFingerprint(body);
  
  const APP_PATH = "apps/mozarthaus_new_buchungssystem_mozarthaus_v1";
  const bookingRef = db.collection(`${APP_PATH}/bookings`).doc(bookingKey);
  const eventRef = db.collection(`${APP_PATH}/events`).doc(eventDocId);

  logFs("03 targets", {
    bookingPath: bookingRef.path,
    eventPath: eventRef.path,
    fingerprintPreview: fingerprint.slice(0, 80) + (fingerprint.length > 80 ? "…" : ""),
  });

    try {
      await db.runTransaction(async (tx) => {
        const [bookingSnap, eventSnap] = await Promise.all([
          tx.get(bookingRef),
          tx.get(eventRef),
        ]);

        logFs("04 tx: fetched booking + event", {
          bookingKey,
          bookingExists: bookingSnap.exists,
          eventExists: eventSnap.exists,
        });

        const previousBooking = bookingSnap.exists ? bookingSnap.data() : null;
        const existingEvent = eventSnap.exists ? eventSnap.data() : {};
        const currentOccupied = Math.max(0, toInt(existingEvent.occupied, 0));

        const nextEffectiveQty = getEffectiveQty(body);
        const nextOccupying = isOccupyingSeat(body);
        const nextSeats = nextOccupying ? nextEffectiveQty : 0;

        // Determine how many seats were previously counted towards the event capacity.
        // We use `seatsAppliedToEvent` as the explicit source of truth.
        const prevApplied =
          previousBooking != null
            ? Math.max(0, toInt(previousBooking.seatsAppliedToEvent, 0))
            : 0;

        // If the payload matches the last processed one exactly, skip (unless repair is needed).
        if (
          previousBooking?.lastFingerprint === fingerprint &&
          currentOccupied > 0 &&
          prevApplied === nextSeats
        ) {
          logFs("05 tx SKIP (duplicate fingerprint)", { bookingKey });
          return;
        }

        const seatDelta = nextSeats - prevApplied;
        const nextOccupied = Math.max(0, currentOccupied + seatDelta);

        logFs("06 tx: result", {
          status: body.status,
          nextSeats,
          prevApplied,
          seatDelta,
          nextOccupied,
        });

        const patch = {
          occupied: nextOccupied,
          title: existingEvent.title ?? body.product_name ?? body.ticket_name ?? "",
          status: existingEvent.status ?? "active",
          regiondoId:
            existingEvent.regiondoId ?? String(body.product_supplier_id ?? body.product_id ?? ""),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        const dateMatch = String(body.event_date_time ?? "").match(
          /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/
        );
        if (dateMatch && !existingEvent.time) {
          patch.time = `${dateMatch[1]}:${dateMatch[2]}`;
        }
        if (!existingEvent.date && body.event_date_time) {
          const eventDate = new Date(body.event_date_time);
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
            lastReceivedAt: payload.receivedAt,
            lastPayload: body,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            createdAt:
              previousBooking?.createdAt ?? admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      });
      logFs("08 tx: COMMIT OK", { bookingKey, eventDocId });
    } catch (err) {
    console.error("[webhook→firestore] TRANSACTION FAILED:", err?.message || err);
    if (err?.code) console.error("[webhook→firestore] error.code:", err.code);
    console.error(err);
  }
}

function enqueueWebhookProcessing(payload) {
  logFs("queue: enqueue");
  webhookQueue = webhookQueue
    .then(async () => {
      await processWebhookToFirestore(payload);
      logFs("queue: done");
    })
    .catch((err) => {
      console.error("[webhook→firestore] queue handler failed:", err?.message || err);
      console.error(err);
    });
}

// Parse JSON bodies (Regiondo typically sends application/json)
app.use(express.json({ limit: "2mb" }));

// Optional: parse urlencoded if Regiondo ever uses form posts
app.use(express.urlencoded({ extended: true }));

app.post("/webhook/regiondo", (req, res) => {
  const receivedAt = new Date().toISOString();
  const payload = {
    receivedAt,
    headers: req.headers,
    body: req.body,
  };

  // Respond immediately so Regiondo gets 200 OK before any other work (logging, SSE, etc.).
  res.status(200).json({ ok: true, receivedAt });

  setImmediate(() => {
    console.log("\n========== Regiondo webhook ==========");
    console.log("Time:", receivedAt);
    console.log("Headers:", JSON.stringify(req.headers, null, 2));
    console.log("Body:", JSON.stringify(req.body, null, 2));
    console.log("======================================\n");
    console.log(
      "[webhook→firestore] 00 after 200 OK → setImmediate: will enqueue Firestore (see [webhook→firestore] steps)"
    );

    webhookHistory.push(payload);
    if (webhookHistory.length > MAX_HISTORY) webhookHistory.shift();
    broadcastToBrowsers(payload);
    enqueueWebhookProcessing(payload);
  });
});

// Some dashboards probe the URL with GET/HEAD before saving; Regiondo may still require POST for real events.
app.get("/webhook/regiondo", (_req, res) => {
  res.status(200).type("text/plain").send("ok");
});
app.head("/webhook/regiondo", (_req, res) => {
  res.status(200).end();
});

/** Live stream of webhooks to the browser (EventSource). */
app.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  sseClients.add(res);
  res.write(": ok\n\n");

  req.on("close", () => {
    sseClients.delete(res);
  });
});

/** Recent webhooks (same shape as SSE payloads) for first paint / refresh. */
app.get("/api/webhooks", (_req, res) => {
  res.json({ events: webhookHistory });
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    firestore: Boolean(db),
    firebaseProjectId: getFirebaseProjectId(),
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Regiondo webhook log</title>
  <style>
    :root { font-family: system-ui, sans-serif; background: #0f1419; color: #e7e9ea; }
    body { margin: 0; padding: 1rem 1.25rem; max-width: 960px; }
    h1 { font-size: 1.1rem; font-weight: 600; margin: 0 0 0.5rem; }
    p.hint { color: #8b98a5; font-size: 0.875rem; margin: 0 0 1rem; }
    #log {
      background: #000;
      color: #d1f7c4;
      font-family: ui-monospace, monospace;
      font-size: 12px;
      line-height: 1.45;
      padding: 1rem;
      border-radius: 8px;
      white-space: pre-wrap;
      word-break: break-word;
      min-height: 200px;
      max-height: 70vh;
      overflow: auto;
      border: 1px solid #2f3336;
    }
    .empty { color: #71767b; }
  </style>
</head>
<body>
  <h1>Regiondo webhooks</h1>
  <p class="hint">Open DevTools (F12) → <strong>Console</strong> to see each payload logged with <code>console.log</code>. This page also lists events below.</p>
  <div id="log" class="empty">Waiting for webhooks…</div>
  <script>
    const el = document.getElementById("log");
    let count = 0;

    function appendEvent(data) {
      count += 1;
      if (el.classList.contains("empty")) {
        el.classList.remove("empty");
        el.textContent = "";
      }
      const block = "--- #" + count + " " + data.receivedAt + " ---\\n" +
        JSON.stringify(data, null, 2) + "\\n\\n";
      el.textContent += block;
      el.scrollTop = el.scrollHeight;
      console.log("[Regiondo webhook]", data);
    }

    fetch("/api/webhooks")
      .then((r) => r.json())
      .then(({ events }) => {
        events.forEach(appendEvent);
      })
      .catch(() => {});

    const es = new EventSource("/stream");
    es.onmessage = (e) => {
      try {
        appendEvent(JSON.parse(e.data));
      } catch (_) {}
    };
    es.onerror = () => {};
  </script>
</body>
</html>`);
});

const server = app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
  console.log(`Browser log: http://localhost:${PORT}/`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook/regiondo`);
  console.log(`Health:      http://localhost:${PORT}/health`);
  console.log(`Firestore:   ${db ? "enabled" : "disabled (missing credentials)"}`);
  if (db) {
    const pid = getFirebaseProjectId();
    console.log(
      `Firebase project (Admin SDK): ${pid || "unknown — check FIREBASE_SERVICE_ACCOUNT_JSON.project_id"}`
    );
    console.log(
      "Open Firestore in the SAME project: https://console.firebase.google.com/project/" +
        (pid || "_") +
        "/firestore"
    );
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Stop the other process, or run on another port (PORT=3001 npm start / $env:PORT=3001; npm start).`
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});
