const admin = require("firebase-admin");
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "../.env.local") });

function getFirebaseCredentialsFromEnv() {
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
  console.error("Firebase credentials missing in .env.local");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(creds),
});

const db = admin.firestore();
const MOZARTHAUS_APP_DOC = "mozarthaus_new_buchungssystem_mozarthaus_v1";

async function cleanupEvents() {
  console.log("Starting cleanup of non-Mozart Ensemble events...");

  const eventsRef = db.collection("apps").doc(MOZARTHAUS_APP_DOC).collection("events");

  const snapshot = await eventsRef.get();
  console.log(`Total events found: ${snapshot.size}`);

  let deleteCount = 0;
  let keepCount = 0;
  const batch = db.batch();
  let batchSize = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const title = data.title || "";

    if (title === "Mozart Ensemble") {
      keepCount++;
    } else {
      console.log(`Deleting event: [${doc.id}] "${title}"`);
      batch.delete(doc.ref);
      deleteCount++;
      batchSize++;

      if (batchSize === 500) {
          await batch.commit();
          console.log("Committed batch of 500 deletions.");
          batchSize = 0;
      }
    }
  }

  if (batchSize > 0) {
    await batch.commit();
    console.log("Committed final batch.");
  }

  console.log("Cleanup complete!");
  console.log(`Kept: ${keepCount}`);
  console.log(`Deleted: ${deleteCount}`);
}

cleanupEvents().catch(err => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
