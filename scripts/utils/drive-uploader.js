"use strict";

const path             = require("path");
const fs               = require("fs");
const { Readable }     = require("stream");
const { google }       = require("googleapis");

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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function _findFileByName(drive, filename) {
  const resp = await drive.files.list({
    q: `'${FOLDER_ID}' in parents and name = '${filename}' and trashed = false`,
    driveId: DRIVE_ID,
    corpora: "drive",
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    fields: "files(id)",
    pageSize: 1,
  });
  return resp.data.files[0]?.id ?? null;
}

async function _downloadJson(drive, fileId) {
  const chunks = [];
  const resp = await drive.files.get(
    { fileId, supportsAllDrives: true, alt: "media" },
    { responseType: "stream" }
  );
  return new Promise((resolve, reject) => {
    resp.data
      .on("data", (c) => chunks.push(c))
      .on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (e) { reject(e); }
      })
      .on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// uploadJobJson(jobId, jobData) — upsert a job JSON in Drive
// Creates the file on first call; updates it on subsequent calls.
// Returns the Drive file ID.
// ---------------------------------------------------------------------------

async function uploadJobJson(jobId, jobData) {
  const auth     = getAuth();
  const drive    = google.drive({ version: "v3", auth });
  const filename = `${jobId}.json`;
  const content  = JSON.stringify(jobData, null, 2);

  const existingId = await _findFileByName(drive, filename);

  if (existingId) {
    await drive.files.update({
      fileId: existingId,
      supportsAllDrives: true,
      media: { mimeType: "application/json", body: Readable.from([content]) },
    });
    return existingId;
  }

  const resp = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: filename,
      parents: [FOLDER_ID],
      mimeType: "application/json",
    },
    media: { mimeType: "application/json", body: Readable.from([content]) },
    fields: "id",
  });
  return resp.data.id;
}

// ---------------------------------------------------------------------------
// listJobJsonFiles() — list all application/json files in the Drive folder
// Returns [{id, name}]
// ---------------------------------------------------------------------------

async function listJobJsonFiles() {
  const auth  = getAuth();
  const drive = google.drive({ version: "v3", auth });
  const resp  = await drive.files.list({
    q: `'${FOLDER_ID}' in parents and mimeType = 'application/json' and trashed = false`,
    driveId: DRIVE_ID,
    corpora: "drive",
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    fields: "files(id, name)",
    pageSize: 1000,
  });
  return resp.data.files || [];
}

// ---------------------------------------------------------------------------
// downloadJobJson(fileId) — download and parse one job JSON by Drive file ID
// ---------------------------------------------------------------------------

async function downloadJobJson(fileId) {
  const auth  = getAuth();
  const drive = google.drive({ version: "v3", auth });
  return _downloadJson(drive, fileId);
}

// ---------------------------------------------------------------------------
// getJobFromDrive(jobId) — search by name and download in one call
// Returns the parsed job object, or null if not found
// ---------------------------------------------------------------------------

async function getJobFromDrive(jobId) {
  const auth   = getAuth();
  const drive  = google.drive({ version: "v3", auth });
  const fileId = await _findFileByName(drive, `${jobId}.json`);
  if (!fileId) return null;
  return _downloadJson(drive, fileId);
}

module.exports = { uploadToDrive, uploadJobJson, listJobJsonFiles, downloadJobJson, getJobFromDrive };
