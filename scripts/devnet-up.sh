#!/usr/bin/env bash
# ==============================================================================
# Hoodium faucet — devnet bring-up
# ==============================================================================
# Runs the full sequence in the right order and stops on the first failure:
#
#   1. preflight  — .env present, RPC reachable, chain ID is 6592
#   2. compile    — hardhat build (needed by deploy + verify:abi)
#   3. verify:abi — proves the admin console's ABI matches the contract
#   4. deploy     — deploy FaucetVault, grant dispenser, apply policy
#   5. seed       — deposit RUNE + mock ERC-20 inventory
#   6. status     — print live vault state
#
# Usage:
#   ./scripts/devnet-up.sh                  # use values from .env
#   FAUCET_SEED_NATIVE_RUNE=500 ./scripts/devnet-up.sh
#
# PREREQUISITES (this script does NOT do these):
#   - .env exists at the repo root (cp .env.example .env) with:
#       HOODIUM_DEVNET_PRIVATE_KEY   a funded devnet account
#       FAUCET_DISPENSER_PRIVATE_KEY a SEPARATE hot key (generated, not reused)
#   - a devnet node answering on HOODIUM_RPC_URL
#   - Redis running (the backend needs it; this script does not)
#
# Exit codes: 0 success, 1 preflight failure, otherwise the failing step's code.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="$ROOT/contracts"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
fail() { printf '\033[1;31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- 1. preflight
step "Preflight"

[ -f "$ROOT/.env" ] || fail ".env missing. Run: cp .env.example .env   (then fill it in)"

# shellcheck disable=SC1091
set -a; . "$ROOT/.env"; set +a

RPC="${HOODIUM_RPC_URL:-http://127.0.0.1:8545}"
printf '  rpc        : %s\n' "$RPC"

[ -n "${FAUCET_DISPENSER_PRIVATE_KEY:-}" ] || fail "FAUCET_DISPENSER_PRIVATE_KEY not set in .env"
[ -n "${HOODIUM_DEVNET_PRIVATE_KEY:-}" ]   || fail "HOODIUM_DEVNET_PRIVATE_KEY not set in .env"

# Format-check both keys here. ethers accepts a comma-separated list for the
# deployer, so only the first entry is validated. A malformed key otherwise fails
# much later with an obscure ethers error, after gas has been considered.
key_ok() { [[ "$1" =~ ^(0x)?[0-9a-fA-F]{64}$ ]]; }

DEPLOY_KEY_FIRST="${HOODIUM_DEVNET_PRIVATE_KEY%%,*}"
DEPLOY_KEY_FIRST="$(echo "$DEPLOY_KEY_FIRST" | tr -d '[:space:]')"

key_ok "$FAUCET_DISPENSER_PRIVATE_KEY" \
  || fail "FAUCET_DISPENSER_PRIVATE_KEY is not a 32-byte hex key (64 hex chars, optional 0x)"
key_ok "$DEPLOY_KEY_FIRST" \
  || fail "HOODIUM_DEVNET_PRIVATE_KEY is not a 32-byte hex key (64 hex chars, optional 0x)"

# Refuse to reuse one key for both roles.
if [ "${FAUCET_DISPENSER_PRIVATE_KEY}" = "${HOODIUM_DEVNET_PRIVATE_KEY}" ]; then
  fail "FAUCET_DISPENSER_PRIVATE_KEY must NOT equal HOODIUM_DEVNET_PRIVATE_KEY (custody != signing)"
fi

CHAIN_ID="$(curl -s -m 5 -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' "$RPC" \
  | sed -n 's/.*"result":"\([^"]*\)".*/\1/p')" || true

[ -n "${CHAIN_ID:-}" ] || fail "no response from $RPC — is the devnet node running?"

DEC=$((CHAIN_ID))
printf '  chain id   : %s (dec %s)\n' "$CHAIN_ID" "$DEC"

if [ "$DEC" -eq 6590 ]; then
  fail "RPC is Hoodium MAINNET (6590). A faucet must never dispense mainnet tokens."
fi
[ "$DEC" -eq 6592 ] || fail "expected devnet chain id 6592, got $DEC"

cd "$CONTRACTS"

# ------------------------------------------------------------------ 2. compile
step "Compile contracts"
npm run build

# --------------------------------------------------------------- 3. verify ABI
step "Verify admin-console ABI matches the artifact"
npm run verify:abi

# -------------------------------------------------------------------- 4. deploy
step "Deploy FaucetVault + grant dispenser + apply policy"
npm run deploy:devnet

DEPLOYMENT="$CONTRACTS/deployments/hoodiumDevnet.json"
[ -f "$DEPLOYMENT" ] || fail "deploy did not write $DEPLOYMENT"

VAULT="$(python3 -c "import json;print(json.load(open('$DEPLOYMENT'))['contracts']['FaucetVault'])")"
printf '  vault      : %s\n' "$VAULT"

# ---------------------------------------------------------------------- 5. seed
step "Seed inventory"
# Idempotent: mock tokens already present in the deployment file are skipped.
FAUCET_SEED_DEPLOY_MOCKS="${FAUCET_SEED_DEPLOY_MOCKS:-true}" npm run seed:devnet

# -------------------------------------------------------------------- 6. status
step "Live vault state"
npm run status:devnet

step "Done"
cat <<EOF

Next: point the backend at the deployment and start it.

  1. Put these in .env (repo root):
       FAUCET_VAULT_ADDRESS=$VAULT

  2. Start Redis (the backend refuses to run without it):
       docker run -d --name faucet-redis -p 6379:6379 redis:7-alpine

  3. Start the API and the UI:
       cd backend  && npm run dev     # :3000
       cd frontend && npm run dev     # :3001  (proxies /api)

  4. Open the admin console:  http://localhost:3001/#/admin

EOF
