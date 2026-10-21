"use strict";
// Firebase Admin (API modular, firebase-admin v13+).
// Variables: FB_PROJECT_ID, FB_CLIENT_EMAIL, FB_PRIVATE_KEY (los \n escapados se convierten).
const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

const projectId = process.env.FB_PROJECT_ID;
const clientEmail = process.env.FB_CLIENT_EMAIL;
const privateKey = process.env.FB_PRIVATE_KEY
  ? process.env.FB_PRIVATE_KEY.replace(/\\n/g, "\n")
  : undefined;

if (!projectId || !clientEmail || !privateKey) {
  throw new Error(
    "Missing Firebase credentials. Set FB_PROJECT_ID, FB_CLIENT_EMAIL, FB_PRIVATE_KEY in env"
  );
}

const app = getApps()[0] || initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
const db = getFirestore(app);

// Compatibilidad con el estilo anterior que usan las rutas:
// admin.firestore.FieldValue.serverTimestamp() y admin.messaging().sendEachForMulticast(...)
const admin = {
  firestore: { FieldValue },
  messaging: () => getMessaging(app),
};

module.exports = { admin, db, FieldValue };
