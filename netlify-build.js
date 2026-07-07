import fs from "fs";
import { promises as fsp } from "fs";
import path from "path";

const requiredFiles = [
  path.join(process.cwd(), "public", "index.html"),
  path.join(process.cwd(), "public", "styles.css"),
  path.join(process.cwd(), "public", "src", "main.js")
];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) {
    throw new Error(`Missing required Netlify asset: ${file}`);
  }
}

fs.writeFileSync(path.join(process.cwd(), "public", "blueprint-fix.js"), "\"use strict\";\n");

console.log("Netlify static assets are ready in public/");
