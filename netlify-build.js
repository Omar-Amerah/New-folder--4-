"use strict";

const fs = require("fs");
const path = require("path");

const requiredFiles = [
  path.join(__dirname, "public", "index.html"),
  path.join(__dirname, "public", "client.js"),
  path.join(__dirname, "public", "styles.css")
];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) {
    throw new Error(`Missing required Netlify asset: ${file}`);
  }
}

console.log("Netlify static assets are ready in public/");
