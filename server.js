const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const MAX_HISTORY = 100;
const webhookHistory = [];
/** @type {Set<import("http").ServerResponse>} */
const sseClients = new Set();

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

  console.log("\n========== Regiondo webhook ==========");
  console.log("Time:", receivedAt);
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Body:", JSON.stringify(req.body, null, 2));
  console.log("======================================\n");

  webhookHistory.push(payload);
  if (webhookHistory.length > MAX_HISTORY) webhookHistory.shift();
  broadcastToBrowsers(payload);

  // Acknowledge quickly so Regiondo does not retry
  res.status(200).json({ ok: true, receivedAt });
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
