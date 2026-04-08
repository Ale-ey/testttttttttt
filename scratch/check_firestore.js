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
admin.initializeApp({
  credential: admin.credential.cert(creds),
});

const db = admin.firestore();

async function checkEvent() {
  const APP_DOC = "mozarthaus_new_buchungssystem_mozarthaus_v1";
  const eventId = "regiondo_product_23941";
  const path = `apps/${APP_DOC}/events/${eventId}`;
  console.log(`Checking Event: ${path}`);

  const snap = await db
    .collection("apps")
    .doc(APP_DOC)
    .collection("events")
    .doc(eventId)
    .get();
  if (snap.exists) {
    console.log(JSON.stringify(snap.data(), null, 2));
  } else {
    console.log("Event NOT found.");
  }

  process.exit(0);
}

checkEvent().catch(err => {
  console.error(err);
  process.exit(1);
});
