import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config({ path: "../.env" });
dotenv.config();

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
      // Hoodium supports EVM forks up to London plus Shanghai/Cancun execution
      // semantics, but `london` is what the chain's own Hardhat projects target.
      // Deviating here risks opcodes the chain rejects (e.g. no blob txs).
      evmVersion: "london",
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
