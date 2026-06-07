"use strict";

const path = require("path");
const fs   = require("fs");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { uploadToDrive } = require("../scripts/utils/drive-uploader");

const ROOT      = path.resolve(__dirname, "..");
const TEST_FILE = path.join(ROOT, "data/final/test-upload.csv");

// Create a small sample CSV
const csv = [
  "first_name,last_name,title,email,company,city,state",
  "Jane,Smith,CEO,jane@acme.com,Acme Corp,New York,NY",
  "John,Doe,CFO,john@globex.com,Globex,Austin,TX",
  "Alice,Lee,COO,alice@initech.com,Initech,San Francisco,CA",
].join("\n");

fs.mkdirSync(path.dirname(TEST_FILE), { recursive: true });
fs.writeFileSync(TEST_FILE, csv);
console.log(`Created: ${TEST_FILE}`);

(async () => {
  console.log("Uploading to Google Drive…");
  try {
    const url = await uploadToDrive(TEST_FILE, "test-upload.csv");
    console.log("\n✓ Upload successful");
    console.log("  Drive URL:", url);
  } catch (err) {
    console.error("\n✗ Upload failed:", err.message);
    process.exit(1);
  }
})();
