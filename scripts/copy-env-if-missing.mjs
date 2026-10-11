import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");
const examplePath = path.join(root, ".env.example");

if (!fs.existsSync(examplePath)) {
  console.error("Missing .env.example");
  process.exit(1);
}

if (fs.existsSync(envPath)) {
  console.log(".env already exists — left unchanged.");
  process.exit(0);
}

fs.copyFileSync(examplePath, envPath);
console.log("Created .env from .env.example");
