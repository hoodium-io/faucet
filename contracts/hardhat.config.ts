import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
import * as path from "path";

// Load env from the repo root first, then from contracts/ so a local override
// works. Resolved against this file's directory rather than the CWD, so
// `hardhat` behaves the same whether run from `contracts/` or the repo root.
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });
dotenv.config({ path: path.resolve(__dirname, ".env"), override: true });

/**
 * Parses a comma-separated private-key list from an env var.
 * Returns [] when unset, so Hardhat can still run read-only tasks.
 */
function accounts(envVar: string): string[] {
  const raw = process.env[envVar];
  if (!raw) return [];
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .map((k) => (k.startsWith("0x") ? k : `0x${k}`));
}

// ---------------------------------------------------------------------------
// Hoodium Network chain definitions
// ---------------------------------------------------------------------------
// Source of truth: hoodium/docs/networks.md and hoodium/utils/utils.go.
//   testnet  rune_6591  EIP-155 6591
//   devnet   rune_6592  EIP-155 6592
//
// A faucet only exists for networks where tokens have no value, so MAINNET IS
// DELIBERATELY ABSENT. There is no `hoodiumMainnet` network and no
// `deploy:mainnet` script: dispensing real-value RUNE from a public faucet would
// be a funds leak, not a feature. Adding it back is not a config change - it is
// a different product.
//
// Devnet is the active target; testnet is pre-wired so switching is a single
// `--network` flag plus an RPC URL, with no code changes.
//
// NOTE: the Cosmos chain-id carries a `-1` revision suffix (e.g. rune_6592-1)
// while the EVM chain ID is the bare number. Hardhat only needs the number.
// ---------------------------------------------------------------------------
const HOODIUM_NETWORKS = {
  hoodiumDevnet: {
    chainId: 6592,
    rpcUrl: process.env.HOODIUM_DEVNET_RPC_URL || "http://127.0.0.1:8545",
    keyEnv: "HOODIUM_DEVNET_PRIVATE_KEY",
  },
  hoodiumTestnet: {
    chainId: 6591,
    rpcUrl: process.env.HOODIUM_TESTNET_RPC_URL || "",
    keyEnv: "HOODIUM_TESTNET_PRIVATE_KEY",
  },
} as const;

const config: HardhatUserConfig = {
  solidity: {
    // Matches the chain repo's own contracts (tokens/hardhat.config.ts) so
    // bytecode behaves identically to first-party Hoodium contracts.
    version: "0.8.29",
    settings: {
      optimizer: {
        enabled: true,
        // 200 is the code-size/default tradeoff; the vault is not hot-loop
        // heavy, so there is no reason to deviate.
        runs: 200,
      },
      // ---------------------------------------------------------------------
      // evmVersion: "cancun" — VERIFIED against the chain, do not "fix" to london
      // ---------------------------------------------------------------------
      // Evidence, in order of authority:
      //
      // 1. `chains/mainchain/devnet/genesis.json` → app_state.evm.params.chain_config:
      //      london_block: "0", shanghai_time: "0", cancun_time: "0",
      //      prague_time: "0", osaka_time: "0"
      //    Cancun is active from genesis, not pending.
      //
      // 2. `x/evm/types/chain_config.go` `DefaultChainConfig()` sets the same
      //    Shanghai/Cancun/Prague/Osaka timestamps to zero, so this holds for
      //    any chain initialised from the defaults, not just the committed devnet.
      //
      // 3. `docs/evm-compatibility.md` §EIP-5656 (MCOPY):
      //      "supported in the underlying VM when Cancun is active."
      //    So MCOPY — the opcode that fails under `london` — is executable here.
      //
      // 4. `docs/evm-compatibility.md` also states Prague is active on fresh
      //    chains, and that Rune collapses Cancun → Prague → Osaka into a single
      //    upgrade. Targeting `cancun` is therefore conservative-but-correct: it
      //    emits nothing newer than what the chain has shipped.
      //
      // WHY `london` WAS WRONG: it was chosen to avoid blob transactions, but
      // blobs are rejected at the *transaction* layer (EIP-4844 type-3 txs), not
      // by the compiler's EVM target. Compiling for london does not prevent blob
      // txs; it only forbids opcodes the chain actually supports. The practical
      // result was that OpenZeppelin 5.6.x could not compile at all, because
      // `utils/Bytes.sol` uses MCOPY.
      //
      // Verified locally: solc 0.8.29 rejects `utils/Bytes.sol` under `london`
      // with the exact error above, and compiles `FaucetVault.sol` +
      // `MockERC20.sol` with 0 errors / 0 warnings under `cancun`.
      evmVersion: "cancun",
    },
  },

  networks: {
    // In-process network used by unit tests. Unlimited contract size keeps the
    // vault deployable locally regardless of optimizer settings.
    hardhat: {
      chainId: 31337,
      allowUnlimitedContractSize: true,
    },

    // Devnet loopback (a local `runed start` node).
    hoodiumDevnet: {
      chainId: HOODIUM_NETWORKS.hoodiumDevnet.chainId,
      url: HOODIUM_NETWORKS.hoodiumDevnet.rpcUrl,
      accounts: accounts(HOODIUM_NETWORKS.hoodiumDevnet.keyEnv),
    },

    // Public testnet — left with an empty URL until the endpoint exists, so an
    // accidental `--network hoodiumTestnet` fails loudly instead of silently
    // hitting the wrong chain.
    hoodiumTestnet: {
      chainId: HOODIUM_NETWORKS.hoodiumTestnet.chainId,
      url: HOODIUM_NETWORKS.hoodiumTestnet.rpcUrl,
      accounts: accounts(HOODIUM_NETWORKS.hoodiumTestnet.keyEnv),
    },
  },

  // Hoodium has no deployed block explorer yet (docs/evm-wallets.md: "Explorer:
  // none yet"), so there is nothing to verify against. The entry is kept as a
  // placeholder so adding one later is a one-line change.
  etherscan: {
    apiKey: {
      hoodiumDevnet: "empty",
      hoodiumTestnet: "empty",
    },
    customChains: [],
  },

  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
};

export default config;
