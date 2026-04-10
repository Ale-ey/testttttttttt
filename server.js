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
const MAX_STEP_LOG = 500;
const webhookHistory = [];
/** @type {Array<{ at: string; category: string; step: string; detail: unknown }>} */
const webhookStepLog = [];
/** @type {Set<import("http").ServerResponse>} */
const sseClients = new Set();
let webhookQueue = Promise.resolve();

function getFirebaseCredentialsFromEnv() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      // Strip potential wrapping single quotes if the whole JSON was pasted that way
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
        .replace(/^["']|["']$/g, "") // Strip accidental wrapping quotes
        .replace(/\\n/g, "\n"), // Convert literal \n to real newlines
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
  let raw = null;
  try {
    raw = admin.app()?.options?.projectId;
  } catch {
    /* no app */
  }
  if (!raw) raw = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || null;
  if (raw == null) return null;
  // .env sometimes has FIREBASE_PROJECT_ID="my-id" — strip accidental quotes
  const s = String(raw).trim().replace(/^["']|["']$/g, "");
  return s || null;
}

const CANCELLED_STATUSES = new Set([
  "cancelled",
  "canceled",
  "refunded",
  "rejected",
  "rejected_by_supplier",
  "expired",
]);

/** Firestore write: after `approved` or `sent` (register seats), or on cancel/refund (release seats). Skips `booked`, etc. */
function shouldSyncBookingToFirestore(body) {
  const s = String(body?.status ?? "").trim().toLowerCase();
  if (s === "approved" || s === "sent") return true;
  if (CANCELLED_STATUSES.has(s)) return true;
  return false;
}

/** Set WEBHOOK_DEBUG=0 to silence Firestore step logs in production. */
function webhookDebugEnabled() {
  return process.env.WEBHOOK_DEBUG !== "0";
}

function logFs(step, detail) {
  pushUiLog("firestore", step, detail);
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

/** Push a processing step to memory + all SSE clients (named event `webhookstep`). */
function pushUiLog(category, step, detail) {
  const entry = {
    at: new Date().toISOString(),
    category,
    step,
    detail: detail === undefined ? null : detail,
  };
  webhookStepLog.push(entry);
  if (webhookStepLog.length > MAX_STEP_LOG) webhookStepLog.shift();
  let payload;
  try {
    payload = JSON.stringify(entry);
  } catch {
    payload = JSON.stringify({
      at: entry.at,
      category,
      step,
      detail: "[unserializable]",
    });
  }
  const line = `event: webhookstep\ndata: ${payload}\n\n`;
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

function getSeatingTemplate() {
  const seating = {};
  const generateRow = (rowId, count) => {
    const category = ["A", "B", "C"].includes(rowId) ? "A" : "B";
    for (let i = 1; i <= count; i++) {
      const id = `row_${rowId.toLowerCase()}_seat_${i}`;
      seating[id] = {
        bookingId: null,
        category,
        row: rowId,
        number: i,
      };
    }
  };

  generateRow("A", 13);
  generateRow("B", 13);
  generateRow("C", 13);
  generateRow("D", 11);
  generateRow("E", 11);
  [1, 2, 3, 4, 5, 6].forEach((num) => {
    seating[`row_f_seat_${num}`] = {
      bookingId: null,
      category: "B",
      row: "F",
      number: num,
    };
  });

  return seating;
}

async function processWebhookToFirestore(payload) {
  logFs("01 start", { hasDb: Boolean(db) });
  if (!db) {
    pushUiLog("firestore", "ABORT: Firestore not initialized", {
      hint: "Set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_PROJECT_ID + CLIENT_EMAIL + PRIVATE_KEY",
    });
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
    pushUiLog("firestore", "ABORT: booking_key missing", { bodyKeys: Object.keys(body || {}) });
    console.warn("[webhook→firestore] ABORT: booking_key missing after normalize.");
    return;
  }

  if (!shouldSyncBookingToFirestore(body)) {
    logFs("SKIP: intermediate status (no Firestore write)", {
      bookingKey,
      status: body?.status,
      note: "Sync runs for approved or sent (register seats), or cancelled/refunded/rejected/expired to release seats.",
    });
    return;
  }

  const eventDocId = eventDocIdFromPayload(body);
  const fingerprint = buildFingerprint(body);

  const MOZARTHAUS_APP_DOC = "mozarthaus_new_buchungssystem_mozarthaus_v1";
  const appRoot = db.collection("apps").doc(MOZARTHAUS_APP_DOC);
  const bookingRef = appRoot.collection("bookings").doc(bookingKey);
  const eventRef = appRoot.collection("events").doc(eventDocId);

  logFs("03 targets", {
    bookingPath: bookingRef.path,
    eventPath: eventRef.path,
    fingerprintPreview: fingerprint.slice(0, 80) + (fingerprint.length > 80 ? "…" : ""),
  });

  try {
    const isCancelled = CANCELLED_STATUSES.has(String(body.status).toLowerCase());

    await db.runTransaction(async (tx) => {
      const [bookingSnap, eventSnap] = await Promise.all([tx.get(bookingRef), tx.get(eventRef)]);

      logFs("04 tx: fetched states", {
        bookingKey,
        bookingExists: bookingSnap.exists,
        eventExists: eventSnap.exists,
        isCancelled,
      });

      const previousBooking = bookingSnap.exists ? bookingSnap.data() : null;
      let seating = eventSnap.exists ? eventSnap.data().seating || {} : getSeatingTemplate();

      // Skip duplicate fingerprint if seat counts would match
      if (previousBooking?.lastFingerprint === fingerprint && !isCancelled) {
        logFs("05 tx SKIP (duplicate fingerprint)", { bookingKey });
        return;
      }

      let assignedSeatIds = previousBooking?.seatIds || [];

      if (isCancelled) {
        // --- CANCELLATION FLOW ---
        pushUiLog("firestore", "Processing Cancellation", { bookingKey, seatsToRelease: assignedSeatIds.length });
        
        if (assignedSeatIds.length > 0) {
          assignedSeatIds.forEach((sid) => {
            if (seating[sid] && seating[sid].bookingId === bookingKey) {
              seating[sid].bookingId = null;
              // Restore original category
              seating[sid].category = (["A", "B", "C"].includes(seating[sid].row) ? "A" : "B");
            }
          });
          logFs("Cancellation: seats cleared in event map", { released: assignedSeatIds });
        }
        assignedSeatIds = []; // Clear in booking as well
      } else {
        // --- REGISTRATION FLOW ---
        const variation = (body?.variation_name || body?.ticket_name || "").toLowerCase();
        let targetCat = "B";
        if (variation.includes("category a") || variation.includes("kategorie a")) targetCat = "A";
        else if (variation.includes("student")) targetCat = "STUDENT";

        pushUiLog("firestore", "Detected Category", { variation, targetCat });

        // Auto-assign logic
        const requestedQty = getEffectiveQty(body);
        const currentQty = assignedSeatIds.length;

        if (requestedQty !== currentQty) {
          pushUiLog("firestore", "Re-calculating seats", { requested: requestedQty, current: currentQty });
          
          // First, release any existing seats if this is an update
          assignedSeatIds.forEach((sid) => {
            if (seating[sid]) {
              seating[sid].bookingId = null;
              // Restore original category
              seating[sid].category = (["A", "B", "C"].includes(seating[sid].row) ? "A" : "B");
            }
          });

          let availableSeats = [];
          if (targetCat === "STUDENT") {
            // Students prefer Cat B (Rows D-F) but can sit in Cat A (Rows A-C) if needed
            const catB = Object.keys(seating).filter(id => seating[id].category === "B" && seating[id].bookingId === null);
            const catA = Object.keys(seating).filter(id => seating[id].category === "A" && seating[id].bookingId === null);
            availableSeats = [...catB, ...catA];
          } else {
            availableSeats = Object.keys(seating).filter(id => 
              seating[id].category === targetCat && seating[id].bookingId === null
            );
          }

          assignedSeatIds = [];
          for (let i = 0; i < Math.min(requestedQty, availableSeats.length); i++) {
            const sid = availableSeats[i];
            seating[sid].bookingId = bookingKey;
            if (targetCat === "STUDENT") {
              seating[sid].category = "STUDENT";
            }
            assignedSeatIds.push(sid);
          }
          
          pushUiLog("firestore", "Mapped seats", { count: assignedSeatIds.length, seats: assignedSeatIds });
        }
      }

      // Update Event
      const eventPatch = {
        seating,
        title: eventSnap.exists ? eventSnap.data().title : body.product_name || body.ticket_name || "",
        status: eventSnap.exists ? eventSnap.data().status : "active",
        regiondoId: eventSnap.exists 
          ? eventSnap.data().regiondoId 
          : String(body.product_supplier_id ?? body.product_id ?? ""),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      const dateMatch = String(body.event_date_time ?? "").match(/^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/);
      if (dateMatch && (!eventSnap.exists || !eventSnap.data().time)) {
        eventPatch.time = `${dateMatch[1]}:${dateMatch[2]}`;
      }
      if (body.event_date_time && (!eventSnap.exists || !eventSnap.data().date)) {
        const eventDate = new Date(body.event_date_time);
        if (!Number.isNaN(eventDate.getTime())) {
          eventPatch.date = admin.firestore.Timestamp.fromDate(eventDate);
        }
      }

      tx.set(eventRef, eventPatch, { merge: true });

      // Update Booking
      tx.set(
        bookingRef,
        {
          bookingKey,
          eventDocId,
          status: body.status ?? null,
          effectiveQty: getEffectiveQty(body),
          isOccupyingSeat: !isCancelled && assignedSeatIds.length > 0,
          seatIds: assignedSeatIds,
          lastFingerprint: fingerprint,
          lastReceivedAt: payload.receivedAt,
          lastPayload: body,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: previousBooking?.createdAt ?? admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });
    logFs("08 tx: COMMIT OK", { bookingKey, eventDocId });
  } catch (err) {
    const code = err?.code;
    const detail = {
      message: err?.message || String(err),
      code,
    };
    if (code === 7 || String(err?.message || "").includes("PERMISSION_DENIED")) {
      detail.hint =
        "IAM: In Google Cloud → IAM, open the service account from your Admin JSON and add role Cloud Datastore User (or Editor) for project " +
        (getFirebaseProjectId() || "your Firebase project") +
        ". Ensure the key's project_id matches this project.";
      const pid = getFirebaseProjectId() || "";
      detail.iamUrl =
        "https://console.cloud.google.com/iam-admin/iam?project=" + encodeURIComponent(pid);
    }
    pushUiLog("firestore", "TRANSACTION FAILED", detail);
    console.error("[webhook→firestore] TRANSACTION FAILED:", err?.message || err);
    if (err?.code) console.error("[webhook→firestore] error.code:", err.code);
    console.error(err);
  }
}

function enqueueWebhookProcessing(payload) {
  logFs("queue: enqueue");
  const p = webhookQueue
    .then(async () => {
      await processWebhookToFirestore(payload);
      logFs("queue: done");
    })
    .catch((err) => {
      pushUiLog("queue", "handler FAILED", {
        message: err?.message || String(err),
        code: err?.code,
      });
      console.error("[webhook→firestore] queue handler failed:", err?.message || err);
      console.error(err);
    });
  webhookQueue = p;
  return p;
}

// Parse JSON bodies (Regiondo typically sends application/json)
app.use(express.json({ limit: "2mb" }));

// Optional: parse urlencoded if Regiondo ever uses form posts
app.use(express.urlencoded({ extended: true }));

app.post("/webhook/regiondo", async (req, res) => {
  const receivedAt = new Date().toISOString();
  const payload = {
    receivedAt,
    headers: req.headers,
    body: req.body,
  };

  console.log("\n========== Regiondo webhook ==========");
  console.log("Time:", receivedAt);
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Body:", JSON.stringify(req.body, null, 2));
  console.log("======================================\n");

  pushUiLog("webhook", "00 POST received, starting processing...", {
    receivedAt,
    booking_key: payload.body?.booking_key,
    status: payload.body?.status,
  });

  webhookHistory.push(payload);
  if (webhookHistory.length > MAX_HISTORY) webhookHistory.shift();
  broadcastToBrowsers(payload);

  try {
    // We MUST await this on Vercel, otherwise the function may be terminated
    // before the Firestore write completes.
    await enqueueWebhookProcessing(payload);
    
    console.log("[webhook→firestore] Done processing. Sending 200 OK.");
    res.status(200).json({ ok: true, receivedAt, processed: true });
  } catch (err) {
    console.error("[webhook→firestore] Critical failure during processing:", err);
    // Still sending 200 OK to Regiondo to avoid retries if we reached this point,
    // but indicating an error in the response body.
    res.status(200).json({ ok: false, receivedAt, error: err.message });
  }
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

/** Recent processing steps for the debug UI (webhook + Firestore + queue). */
app.get("/api/steps", (_req, res) => {
  res.json({ steps: webhookStepLog });
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
    body { margin: 0; padding: 1rem 1.25rem; max-width: 1100px; }
    h1 { font-size: 1.1rem; font-weight: 600; margin: 0 0 0.5rem; }
    h2 { font-size: 0.95rem; font-weight: 600; margin: 1.25rem 0 0.5rem; color: #c4d0dc; }
    p.hint { color: #8b98a5; font-size: 0.875rem; margin: 0 0 1rem; }
    #steps {
      background: #0a1628;
      color: #7dd3fc;
      font-family: ui-monospace, monospace;
      font-size: 11px;
      line-height: 1.5;
      padding: 0.75rem 1rem;
      border-radius: 8px;
      white-space: pre-wrap;
      word-break: break-word;
      min-height: 120px;
      max-height: 45vh;
      overflow: auto;
      border: 1px solid #1e3a5f;
    }
    #steps .row { border-bottom: 1px solid #1a2f45; padding: 0.35rem 0; }
    #steps .row:last-child { border-bottom: none; }
    #steps .meta { color: #94a3b8; font-size: 10px; }
    #steps .cat { color: #fbbf24; font-weight: 600; }
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
      min-height: 160px;
      max-height: 40vh;
      overflow: auto;
      border: 1px solid #2f3336;
    }
    .empty { color: #71767b; }
    .toolbar { margin: 0.5rem 0; display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
    .toolbar button {
      background: #2f3336;
      color: #e7e9ea;
      border: 1px solid #536471;
      border-radius: 6px;
      padding: 0.25rem 0.6rem;
      font-size: 12px;
      cursor: pointer;
    }
    .toolbar button:hover { background: #3d4246; }
  </style>
</head>
<body>
  <h1>Regiondo webhook debugger</h1>
  <p class="hint">Processing steps (queue + Firestore) update live. Raw payloads below. Set <code>WEBHOOK_DEBUG=0</code> on the server to hide terminal logs only — the UI still receives steps.</p>

  <h2>Processing steps (booking save &amp; occupancy)</h2>
  <div class="toolbar">
    <button type="button" id="clearSteps">Clear step panel</button>
    <span class="hint" style="margin:0">Uses SSE event <code>webhookstep</code> + <code>GET /api/steps</code></span>
  </div>
  <div id="steps" class="empty">Loading steps…</div>

  <h2>Raw webhook payloads</h2>
  <div id="log" class="empty">Waiting for webhooks…</div>
  <script>
    const el = document.getElementById("log");
    const stepsEl = document.getElementById("steps");
    let count = 0;
    let stepCount = 0;

    function appendStep(entry) {
      stepCount += 1;
      const placeholder =
        stepsEl.textContent.includes("No steps yet") ||
        stepsEl.textContent.includes("Loading steps");
      if (stepsEl.classList.contains("empty") || placeholder) {
        stepsEl.classList.remove("empty");
        stepsEl.textContent = "";
      }
      const detail =
        entry.detail != null && typeof entry.detail === "object"
          ? JSON.stringify(entry.detail, null, 2)
          : String(entry.detail ?? "");
      const line =
        "[" + stepCount + "] " +
        entry.at +
        " \\n  " +
        entry.category +
        " → " +
        entry.step +
        (detail ? "\\n  " + detail : "") +
        "\\n\\n";
      stepsEl.textContent += line;
      stepsEl.scrollTop = stepsEl.scrollHeight;
    }

    document.getElementById("clearSteps").addEventListener("click", () => {
      stepCount = 0;
      stepsEl.textContent = "";
      stepsEl.classList.add("empty");
      stepsEl.textContent = "Cleared. New steps will appear below.";
    });

    fetch("/api/steps")
      .then((r) => r.json())
      .then(({ steps }) => {
        if (!steps || steps.length === 0) {
          stepsEl.classList.add("empty");
          stepsEl.textContent = "No steps yet. Send a POST to /webhook/regiondo.";
          return;
        }
        stepsEl.classList.remove("empty");
        stepsEl.textContent = "";
        steps.forEach(appendStep);
      })
      .catch(() => {
        stepsEl.textContent = "Could not load /api/steps";
      });

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
    es.addEventListener("webhookstep", (e) => {
      try {
        appendStep(JSON.parse(e.data));
      } catch (err) {
        console.error("webhookstep parse", err);
      }
    });
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
