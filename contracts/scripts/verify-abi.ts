import { ethers } from "hardhat";
import type { Fragment, InterfaceAbi } from "ethers";
import * as fs from "fs";
import * as path from "path";

/**
 * Verifies the hand-written ABI in `frontend/src/lib/vaultAbi.ts` against the
 * compiled Hardhat artifact.
 *
 * WHY THIS EXISTS: Hoodium has no block explorer, so the admin console cannot
 * fetch an ABI at runtime. The frontend therefore carries the ABI as source. That
 * is only safe if it provably matches the contract, so this script compares the
 * two as *canonical signatures* — which is exactly what ethers uses to dispatch
 * calls, so a match here means a match at runtime.
 *
 * Run after any contract change:
 *   npm run verify:abi
 *
 * Exits non-zero on any drift, so it can gate CI.
 */

const ARTIFACT = path.join(
  __dirname,
  "..",
  "artifacts",
  "contracts",
  "FaucetVault.sol",
  "FaucetVault.json",
);

const ABI_SOURCE = path.join(__dirname, "..", "..", "frontend", "src", "lib", "vaultAbi.ts");

/**
 * Extracts the human-readable ABI entries from the TypeScript source.
 *
 * Deliberately textual rather than importing the module: the file is a `.ts` with
 * `as const`, and importing it would require a TS loader for a script that Hardhat
 * already runs in plain Node.
 */
function readSourceAbi(): string[] {
  if (!fs.existsSync(ABI_SOURCE)) {
    throw new Error(`ABI source not found: ${ABI_SOURCE}`);
  }

  const source = fs.readFileSync(ABI_SOURCE, "utf8");

  // Grab the FAUCET_VAULT_ABI array literal.
  const match = source.match(/FAUCET_VAULT_ABI\s*=\s*\[([\s\S]*?)\]\s*as const/);
  if (!match?.[1]) {
    throw new Error("Could not locate `FAUCET_VAULT_ABI = [...] as const` in vaultAbi.ts");
  }

  const entries: string[] = [];
  // Each entry is a double-quoted line; comments are skipped naturally.
  for (const line of match[1].split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('"')) continue;

    const end = trimmed.lastIndexOf('"');
    if (end <= 0) continue;

    entries.push(trimmed.slice(1, end));
  }

  return entries;
}

/**
 * Canonical signature for a fragment.
 *
 * - `function` / `error` / `event` → `format("sighash")`, i.e. exactly the string
 *   ethers uses to derive a selector or topic hash. Any change is breaking.
 * - `constructor` → `constructor(<input types>)`, so an added/removed constructor
 *   argument is caught. A bare `"constructor"` would hide that.
 * - `fallback` / `receive` → `format()`, because ethers v6 classifies BOTH as
 *   `type: "fallback"` and only distinguishes them in the formatted string. Using
 *   the bare type would make `receive()` and `fallback()` compare as equal.
 */
function signatureOf(fragment: Fragment): string {
  if (fragment.type === "function" || fragment.type === "error" || fragment.type === "event") {
    return fragment.format("sighash");
  }

  if (fragment.type === "constructor") {
    const inputs = (fragment.inputs ?? []).map((i) => i.type).join(",");
    return `constructor(${inputs})`;
  }

  // `fallback` and `receive` both land here; format() yields the distinguishing
  // `receive() payable` / `fallback() payable` strings.
  return fragment.format();
}

/**
 * Buckets fragments by type so the report is readable.
 *
 * NOTE: uses a `Map`, never a plain object. ethers reports `receive` under the
 * `"fallback"` type key, and a plain object would additionally collide with
 * `Object.prototype.constructor` when bucketing constructors — which silently
 * corrupts counts.
 */
function bucket(fragments: readonly Fragment[]): Map<string, string[]> {
  const out = new Map<string, string[]>();

  for (const f of fragments) {
    const key = f.type;
    const list = out.get(key) ?? [];
    list.push(signatureOf(f));
    out.set(key, list);
  }

  for (const list of out.values()) list.sort();
  return out;
}

async function main() {
  if (!fs.existsSync(ARTIFACT)) {
    throw new Error(
      `Compiled artifact not found:\n  ${ARTIFACT}\n\n` +
        `Compile first:\n  cd contracts && npm run build\n`,
    );
  }

  const artifact = JSON.parse(fs.readFileSync(ARTIFACT, "utf8")) as { abi: InterfaceAbi };
  const compiled = bucket(ethers.Interface.from(artifact.abi).fragments);

  const sourceAbi = readSourceAbi();
  const declared = bucket(ethers.Interface.from(sourceAbi).fragments);

  console.log("");
  console.log("ABI verification — FaucetVault");
  console.log(`  source  : ${path.relative(process.cwd(), ABI_SOURCE)}`);
  console.log(`  artifact: ${path.relative(process.cwd(), ARTIFACT)}`);
  console.log("");

  let drift = false;

  const kinds = new Set([...compiled.keys(), ...declared.keys()]);

  for (const kind of [...kinds].sort()) {
    const inContract = compiled.get(kind) ?? [];
    const inSource = declared.get(kind) ?? [];

    const missing = inContract.filter((s) => !inSource.includes(s));
    const extra = inSource.filter((s) => !inContract.includes(s));

    if (missing.length === 0 && extra.length === 0) {
      console.log(`  ✓ ${kind} (${inContract.length})`);
      continue;
    }

    drift = true;
    console.log(`  ✗ ${kind}`);

    for (const s of missing) console.log(`      missing from vaultAbi.ts : ${s}`);
    for (const s of extra) console.log(`      not in the contract      : ${s}`);
  }

  console.log("");

  if (drift) {
    console.error(
      "ABI DRIFT DETECTED.\n" +
        "Update frontend/src/lib/vaultAbi.ts so it matches the compiled contract,\n" +
        "or the admin console will call functions that do not exist.\n",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`ABI is in sync (${sourceAbi.length} entries).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
