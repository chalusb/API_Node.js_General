"use strict";

const admin = require("firebase-admin");

// Initialize Firebase Admin SDK using env credentials
// Expecting env vars: FB_PROJECT_ID, FB_CLIENT_EMAIL, FB_PRIVATE_KEY
// Note: FB_PRIVATE_KEY should have \n escaped newlines; we replace them.
const projectId = process.env.FB_PROJECT_ID;
const clientEmail = process.env.FB_CLIENT_EMAIL;
const privateKey = process.env.FB_PRIVATE_KEY
  ? process.env.FB_PRIVATE_KEY.replace(/\\n/g, "\n")
  : undefined;

if (!admin.apps.length) {
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Missing Firebase credentials. Set FB_PROJECT_ID, FB_CLIENT_EMAIL, FB_PRIVATE_KEY in env"
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
}

const db = admin.firestore();

module.exports = { admin, db };

