"use strict";

const path   = require("path");
const fs     = require("fs");
const { google } = require("googleapis");

const ROOT          = path.resolve(__dirname, "../..");
const FOLDER_ID     = "1VCUSCJ0uG7wwobl_e58Zr3NtfLTyBL6M";
const KEY_FILE_PATH = path.join(ROOT, "config/google-service-account.json");

// ---------------------------------------------------------------------------
// Auth — GOOGLE_SERVICE_ACCOUNT_JSON env var takes priority over key file
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

  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });
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
    requestBody: { role: "reader", type: "anyone" },
  });

  return webViewLink || `https://drive.google.com/file/d/${fileId}/view`;
}

module.exports = { uploadToDrive };
