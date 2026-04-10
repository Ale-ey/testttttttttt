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

async function resetFirestore() {
  console.log("Starting full reset of Regiondo data in Firestore...");

  const appRoot = db.collection("apps").doc(MOZARTHAUS_APP_DOC);
  const bookingsRef = appRoot.collection("bookings");
  const eventsRef = appRoot.collection("events");

  // 1. Delete all bookings
  console.log("Deleting all documents in 'bookings' collection...");
  const bookingDocs = await bookingsRef.get();
  console.log(`Found ${bookingDocs.size} bookings to delete.`);
  
  if (bookingDocs.size > 0) {
    const batchSize = 500;
    for (let i = 0; i < bookingDocs.size; i += batchSize) {
      const batch = db.batch();
      const chunk = bookingDocs.docs.slice(i, i + batchSize);
      chunk.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      console.log(`Deleted chunk ${i / batchSize + 1}`);
    }
  }

  // 2. Reset all event occupancy
  console.log("Resetting 'occupied' count to 0 for all events...");
  const eventDocs = await eventsRef.get();
  console.log(`Found ${eventDocs.size} events to reset.`);

  if (eventDocs.size > 0) {
    const batchSize = 500;
    for (let i = 0; i < eventDocs.size; i += batchSize) {
      const batch = db.batch();
      const chunk = eventDocs.docs.slice(i, i + batchSize);
      chunk.forEach(doc => batch.update(doc.ref, { occupied: 0 }));
      await batch.commit();
      console.log(`Reset chunk ${i / batchSize + 1}`);
    }
  }

  console.log("Reset complete! Firestore is ready for fresh sync.");
}

resetFirestore().catch(err => {
  console.error("Reset failed:", err);
  process.exit(1);
});
