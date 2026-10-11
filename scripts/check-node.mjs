/**
 * Stops `npm install` early, with a plain message, on a Node.js too old for this app. The
 * scripts are TypeScript run straight by Node (type stripping, on by default from 22.18)
 * and the privacy check uses node:sqlite, so older versions fail later in confusing ways.
 * Runs as the preinstall step, before any dependency exists, so it imports nothing.
 */
const [major, minor] = process.versions.node.split(".").map(Number);
// 22.18+, or 23.6+ (Node 23 turned type stripping on by default in 23.6), or 24 and later.
const tooOld = major < 22 || (major === 22 && minor < 18) || (major === 23 && minor < 6);
if (tooOld) {
  console.error(
    `\nRaponiberg needs Node.js 22.18 or newer; this is ${process.versions.node}.\n` +
      "Install the current LTS from https://nodejs.org (or run `nvm use` in this folder),\n" +
      "open a new terminal, and run npm install again.\n",
  );
  process.exit(1);
}
