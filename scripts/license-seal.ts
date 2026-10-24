/**
 * The copyright holder's two commands for the license signature (docs/license-protection.md).
 * They are meant to be run by a person, in a terminal, typing a passphrase that is never
 * passed in a file, an option or an environment variable.
 *
 *   npm run license:keygen   makes the signing key, encrypted with a passphrase, in your home
 *                            folder (never in this repository), and prints its fingerprint.
 *   npm run license:seal     after any deliberate change to the LICENSE, the assistant rules
 *                            or the license scripts: refreshes every pin and copy, then signs
 *                            the hashes of the files the signature covers (.license-seal.json).
 *                            To move to a new key (run keygen with --key <new file> first):
 *                            license:seal -- --key <new file> --old-key <old file>. The old key
 *                            signs the hand-over, so nobody else can take the owner role.
 *
 * Without the key, nobody can produce a signature the check accepts, however convincingly
 * they claim to be the owner.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import readline from "node:readline";
import { Writable } from "node:stream";
import { checkLicense, read, ROOT, rotationMessage, SEAL_FILE, SEALED_FILES, sealMessage, sha256, signerOf, writePins, type Rotation, type Seal } from "./license-guard.ts";

const DEFAULT_KEY = path.join(os.homedir(), ".raponiberg", "license-signing-key.pem");

/** A new Ed25519 key: the private half as passphrase-encrypted PEM, the public half as base64 DER. */
export function generateOwnerKey(passphrase: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase },
    publicKeyEncoding: { type: "spki", format: "der" },
  });
  const publicKeyBase64 = publicKey.toString("base64");
  return { privateKey, publicKey: publicKeyBase64, signer: signerOf(publicKeyBase64) };
}

const openKey = (pem: string, passphrase: string) => {
  try {
    return createPrivateKey({ key: pem, passphrase });
  } catch {
    throw new Error("That passphrase doesn't open the signing key (or the key file is damaged).");
  }
};
const publicOf = (key: ReturnType<typeof createPrivateKey>) => createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");

type SealOptions = {
  /** The key being replaced. Handing the owner role to a new key needs its signature. */
  old?: { pem: string; passphrase: string };
  /** The old key is gone: the new key starts a chain nothing vouches for, which --since and --upstream will flag until you merge it yourself on GitHub. */
  replaceLostKey?: boolean;
};

/** Refreshes every pin and copy for the current LICENSE and writes the signed seal. Returns the signer. */
export function seal(root: string, privatePem: string, passphrase: string, options: SealOptions = {}): string {
  const key = openKey(privatePem, passphrase);
  const publicKey = publicOf(key);
  const signer = signerOf(publicKey);
  const pinned = checkLicense(root).signer;
  let rotations: Rotation[] = [];
  try {
    rotations = (JSON.parse(read(root, SEAL_FILE) ?? "{}") as Seal).rotations ?? [];
  } catch {
    /* no earlier seal to carry rotations from */
  }
  if (pinned && pinned !== "none" && pinned !== signer) {
    if (options.replaceLostKey) rotations = [];
    else if (!options.old) throw new Error(`This key (${signer}) isn't the owner key already pinned (${pinned}). To hand the role over, also pass --old-key <the old key file> and type its passphrase; if that key is lost, pass --replace-lost-key instead.`);
    else {
      const oldKey = openKey(options.old.pem, options.old.passphrase);
      const oldPublic = publicOf(oldKey);
      if (signerOf(oldPublic) !== pinned) throw new Error(`The old key is ${signerOf(oldPublic)}, not the pinned owner key ${pinned}.`);
      rotations = [...rotations, { fromPublicKey: oldPublic, to: signer, signature: sign(null, Buffer.from(rotationMessage(pinned, signer)), oldKey).toString("base64") }];
    }
  }
  const license = read(root, "LICENSE");
  if (license === null) throw new Error("LICENSE is missing: run npm run license:restore first.");
  writePins(root, license, signer);
  const files: Record<string, string> = {};
  for (const f of SEALED_FILES) {
    const text = read(root, f);
    if (text === null) throw new Error(`${f} is missing, so it can't be sealed.`);
    files[f] = sha256(text);
  }
  const body: Omit<Seal, "signature"> = { version: 1, licenseSha256: files.LICENSE, signer, publicKey, files, ...(rotations.length ? { rotations } : {}) };
  const signature = sign(null, Buffer.from(sealMessage(files)), key).toString("base64");
  writeFileSync(path.join(root, SEAL_FILE), JSON.stringify({ ...body, signature }, null, 2) + "\n");
  return signer;
}

/** Reads a line from the terminal without echoing it. */
async function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("Run this yourself in a terminal: the passphrase is typed at a prompt, never passed in a file, option or variable.");
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!muted) process.stdout.write(chunk, encoding);
      done();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write(question);
  muted = true;
  try {
    return await new Promise<string>((resolve) => rl.question("", resolve));
  } finally {
    rl.close();
    process.stdout.write("\n");
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const keyFlag = args.indexOf("--key");
  const keyFile = keyFlag >= 0 ? path.resolve(args[keyFlag + 1] ?? "") : DEFAULT_KEY;

  if (cmd === "keygen") {
    if (keyFile === ROOT || keyFile.startsWith(ROOT + path.sep)) throw new Error("Keep the signing key outside this repository.");
    if (existsSync(keyFile)) throw new Error(`${keyFile} already exists; it is not overwritten. Move it away first if you really mean to replace it.`);
    const pass = await askHidden("New passphrase for the signing key (12+ characters): ");
    if (pass.length < 12) throw new Error("Use at least 12 characters.");
    if (pass !== (await askHidden("Type it again: "))) throw new Error("The two passphrases differ.");
    const key = generateOwnerKey(pass);
    mkdirSync(path.dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, key.privateKey, { flag: "wx", mode: 0o600 });
    console.log(`\nSigning key written to ${keyFile}\nOwner key fingerprint: ${key.signer}\n\nBack the file up somewhere private (and remember the passphrase): without it, nobody can\nchange the license ever again. Don't put it in this repository or on a shared drive.\nNext: npm run license:seal`);
  } else if (cmd === "seal") {
    if (!existsSync(keyFile)) throw new Error(`No signing key at ${keyFile}. Run npm run license:keygen first (or pass --key <file>).`);
    const oldFlag = args.indexOf("--old-key");
    const oldFile = oldFlag >= 0 ? path.resolve(args[oldFlag + 1] ?? "") : null;
    if (oldFile && !existsSync(oldFile)) throw new Error(`No old signing key at ${oldFile}.`);
    const pass = await askHidden("Signing key passphrase: ");
    const old = oldFile ? { pem: readFileSync(oldFile, "utf8"), passphrase: await askHidden("OLD signing key passphrase: ") } : undefined;
    const signer = seal(ROOT, readFileSync(keyFile, "utf8"), pass, { old, replaceLostKey: args.includes("--replace-lost-key") });
    console.log(`\nSealed with owner key ${signer}: every pin and copy refreshed, ${SEAL_FILE} written.\nCommit these changes, then run npm run license:check.`);
  } else {
    throw new Error("Usage: npm run license:keygen, or npm run license:seal (-- --key <file>; to replace the key: -- --old-key <file>, or -- --replace-lost-key)");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`\n${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
