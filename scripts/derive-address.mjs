#!/usr/bin/env node
/**
 * Derives the EVM address for a private key, so a key can be checked against the
 * funded account BEFORE it is written into `.env`.
 *
 * Why this exists: `.env` holds a hot key. A typo'd or wrong key silently points
 * the faucet at an empty/unfunded account, and the failure only shows up later as
 * "insufficient funds" mid-claim. Verifying the address first is one command.
 *
 * Usage:
 *   node scripts/derive-address.mjs                 # prompts, input hidden
 *   node scripts/derive-address.mjs 0x<64 hex>      # inline (shell history!)
 *   echo 0x<64 hex> | node scripts/derive-address.mjs
 *
 * ⚠️ Inline args land in shell history. Prefer the prompt or a pipe.
 *
 * Nothing is written anywhere and no network call is made.
 */
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { createRequire } from "node:module";

// Resolve ethers from the backend (it is already a dependency there) so this
// helper needs no install of its own.
const require = createRequire(import.meta.url);
const ethers = require(resolve(process.cwd(), "backend", "node_modules", "ethers"));

const { Wallet, getAddress } = ethers;

/** Reads a hidden line from the TTY. */
function promptHidden(question) {
  return new Promise((res, rej) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

    // Suppress echo so the key does not appear on screen.
    const onData = (char) => {
      if (["\n", "\r", "\u0004"].includes(char.toString())) return;
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
      process.stdout.write(question);
    };

    process.stdin.on("data", onData);
    rl.question(question, (answer) => {
      process.stdin.off("data", onData);
      rl.close();
      process.stdout.write("\n");
      res(answer.trim());
    });
    rl.on("SIGINT", () => { rl.close(); rej(new Error("cancelled")); });
  });
}

async function readKey() {
  const arg = process.argv[2];
  if (arg) return arg.trim();

  // Piped stdin? Read it without prompting.
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const piped = Buffer.concat(chunks).toString().trim();
    if (piped) return piped;
  }

  return promptHidden("Private key (hidden): ");
}

function main() {
  const raw = (() => {
    try { return readKey(); } catch { return null; }
  })();

  return Promise.resolve(raw).then((rawKey) => {
    if (!rawKey) {
      console.error("No private key supplied.");
      process.exit(2);
    }

    const key = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;

    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      console.error("Not a 32-byte hex private key (expected 64 hex chars, optional 0x).");
      process.exit(1);
    }

    const wallet = new Wallet(key);

    console.log("");
    console.log("  EVM address (checksummed) :", getAddress(wallet.address));
    console.log("  EVM address (lowercase)   :", wallet.address.toLowerCase());
    console.log("");
    console.log("  Compare with the funded account in the deployment notes.");
    console.log("  A mismatch means the wrong key — do NOT put it in .env.");
    console.log("");
  });
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
