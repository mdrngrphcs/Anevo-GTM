"use strict";

const path   = require("path");
const fs     = require("fs");
const { google } = require("googleapis");

const ROOT          = path.resolve(__dirname, "../..");
const FOLDER_ID     = "0AM-9n4GWmWD5Uk9PVA";
const DRIVE_ID      = "0AM-9n4GWmWD5Uk9PVA";
const KEY_FILE_PATH = path.join(ROOT, "config/google-service-account.json");

// ---------------------------------------------------------------------------
// Auth — GOOGLE_SERVICE_ACCOUNT_JSON env var takes priority over key file.
// Set GOOGLE_IMPERSONATE_EMAIL to a folder owner's address when the target
// folder is in a personal My Drive (requires domain-wide delegation on the
// service account in Google Workspace Admin Console).
// ---------------------------------------------------------------------------

function getAuth() {
  let credentials;

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is set but contains invalid JSON");
    }
  } else if (fs.existsSync(KEY_FILE_PATH)) {
    credentials = JSON.parse(fs.readFileSync(KEY_FILE_PATH, "utf8"));
  } else {
    throw new Error(
      "No Google credentials found. Set GOOGLE_SERVICE_ACCOUNT_JSON or provide config/google-service-account.json"
    );
  }

  const authOpts = {
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive"],
  };

  // Impersonate the folder owner when targeting a personal My Drive
  if (process.env.GOOGLE_IMPERSONATE_EMAIL) {
    authOpts.clientOptions = { subject: process.env.GOOGLE_IMPERSONATE_EMAIL };
  }

  return new google.auth.GoogleAuth(authOpts);
}

// ---------------------------------------------------------------------------
// uploadToDrive(localFilePath, fileName) → Drive file URL
// ---------------------------------------------------------------------------

async function uploadToDrive(localFilePath, fileName) {
  const auth   = getAuth();
  const drive  = google.drive({ version: "v3", auth });

  const fileSize = fs.statSync(localFilePath).size;
  const mimeType = "text/csv";

  const response = await drive.files.create({
    supportsAllDrives:       true,
    driveId:                 DRIVE_ID,
    corpora:                 "drive",
    includeItemsFromAllDrives: true,
    requestBody: {
      name:    fileName,
      parents: [FOLDER_ID],
    },
    media: {
      mimeType,
      body: fs.createReadStream(localFilePath),
    },
    fields: "id, webViewLink",
  });

  const fileId      = response.data.id;
  const webViewLink = response.data.webViewLink;

  // Make the file readable by anyone with the link
  await drive.permissions.create({
    fileId,
    supportsAllDrives: true,
    requestBody: { role: "reader", type: "anyone" },
  });

  return webViewLink || `https://drive.google.com/file/d/${fileId}/view`;
}

module.exports = { uploadToDrive };
