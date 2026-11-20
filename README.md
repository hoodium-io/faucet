# Hoodium Faucet

A faucet for **Hoodium Network** chains — **Devnet** and **Testnet only**.

> **Test tokens only.** Nothing here has financial value. Devnet is reset
> periodically.
>
> **Mainnet is deliberately not supported.** A faucet hands out tokens that are
> worth nothing by design; on mainnet those tokens are real money, so a mainnet
> faucet would be a funds leak rather than a feature. The backend rejects
> `HOODIUM_NETWORK=mainnet` at startup, and both the deploy script and the chain
> check refuse an RPC reporting chain ID `6590`.

## Architecture — a deposit vault, not a minting faucet

The faucet **does not mint**. It is the standard "custody vault + authorised
dispense" pattern:

```
                    ┌──────────────────────────┐
  treasurer ───────▶│      FaucetVault.sol     │◀───── dispenser (backend)
  deposit()         │  single custody point    │       dispense()
                    │                          │
                    │  • drip size             │──────▶ recipient wallet
                    │  • per-recipient cooldown│        (plain ERC-20/native
                    │  • cross-token cooldown  │         transfer — never a mint)
                    │  • rolling 24h cap       │
                    │  • inventory check       │
                    └──────────────────────────┘
```

Why this shape matters:

| Concern | Where it lives |
|---|---|
| Who holds the tokens | The **vault contract**, not the backend |
| Who can move them out | Only an account with `DISPENSER_ROLE` |
| How much per claim | On-chain policy (`dripAmount`), never chosen by the server |
| Rate limits | Enforced **on-chain** *and* off-chain (Redis/CAPTCHA) |

**Users never interact with token contracts, and nothing is minted at claim
time.** The backend's hot key can only move inventory that already exists, and
only within the caps — so a stolen backend key cannot mint, cannot withdraw
custody, and cannot exceed the daily cap.

Two layers of enforcement, deliberately:

| Layer | Enforces | Defeated by |
|---|---|---|
| **On-chain** (vault) | drip, cooldowns, 24h cap, inventory | Nothing short of admin access |
| **Off-chain** (API) | CAPTCHA, per-IP budget, Redis cooldowns | Compromised backend (but caps still hold) |

The on-chain limits are authoritative. Redis is a fast rejection cache, never the
only defence.

## Repository layout

```
faucet/
├── contracts/                  Hardhat project
│   ├── contracts/
│   │   ├── FaucetVault.sol     ← the custody vault (core)
│   │   └── MockERC20.sol       ← devnet inventory provisioning only
│   ├── scripts/
│   │   ├── deploy.ts           deploy + verify chain ID + write deployments/
│   │   ├── seed-devnet.ts      fund the vault (native + mock ERC-20s)
│   │   ├── grant-dispenser.ts  grant DISPENSER_ROLE to the backend key
│   │   └── inspect-vault.ts    print live vault state
│   └── test/FaucetVault.test.ts
├── backend/                    Express + ethers v6 + Redis
│   └── src/
│       ├── config.ts           env validation + Hoodium network table
│       ├── services/vault.ts   all chain interaction
│       ├── services/claim.ts   the claim pipeline
│       ├── services/captcha.ts Turnstile / reCAPTCHA
│       ├── lib/rate-limiter.ts Redis cooldowns
│       └── lib/tx-queue.ts     nonce-safe serialisation
├── frontend/                   Vite + React 19 + Tailwind
│   └── src/
│       ├── components/         public claim flow
│       ├── admin/              ← vault admin console (#/admin)
│       │   ├── AdminPage.tsx   page shell + hash route target
│       │   ├── useAdmin.ts     wallet + chain state, tx lifecycle
│       │   ├── WalletPanel.tsx     connect, roles, wrong-network switch
│       │   ├── PolicyPanel.tsx     drip/cooldown/cap editor
│       │   ├── InventoryPanel.tsx  deposit / withdraw
│       │   └── ControlsPanel.tsx   pause, cooldown, roles, rescue
│       └── lib/
│           ├── vaultAbi.ts     hand-written ABI (verified by verify:abi)
│           ├── adminVault.ts   typed vault + ERC-20 wrappers
│           └── wallet.ts       EIP-1193 connect / chain switch
├── docker-compose.yml
└── .env.example
```

## Hoodium network parameters

Verified against the chain repo (`docs/networks.md`, `utils/utils.go`).

| Network | Cosmos chain-id | EVM chain ID | Gas token | Faucet? |
|---|---|---|---|---|
| Devnet | `rune_6592-1` | **6592** | RUNE (18 dp) | ✅ active target |
| Testnet | `rune_6591-1` | 6591 | RUNE (18 dp) | ✅ pre-wired |
| ~~Mainnet~~ | ~~`rune_6590-1`~~ | ~~6590~~ | ~~RUNE~~ | ❌ **not supported** |

Devnet exposes standard Ethereum JSON-RPC on `8545`. RUNE and HOODI are **native
precompiles** on Hoodium (not deployed contracts) — which is exactly why the
faucet holds inventory in a vault and transfers it, rather than trying to mint.

Mainnet is omitted because the premise of a faucet — freely distributable tokens
— only holds where the tokens have no value.

## Quick start (devnet)

```bash
# 0. Environment
cp .env.example .env
chmod 600 .env          # it will hold a private key
#    Edit .env: set HOODIUM_DEVNET_PRIVATE_KEY (a funded devnet account) and
#    FAUCET_DISPENSER_PRIVATE_KEY (a dedicated hot key — see below).

# 1. Contracts
cd contracts
npm install
npm test                 # vault unit tests on the in-process chain
npm run deploy:devnet    # writes deployments/hoodiumDevnet.json

# 2. Grant the backend's dispenser key
cd ../contracts && FAUCET_DISPENSER_ADDRESS=0x... npm run grant-dispenser:devnet

# 3. Inventory
FAUCET_SEED_NATIVE_RUNE=100 FAUCET_SEED_DEPLOY_MOCKS=true npm run seed:devnet

# 4. Run
cd ../backend && npm install && npm run dev     # API on :3000
cd ../frontend && npm install && npm run dev    # UI on :3001 (proxies /api)
```

Verify at any point:

```bash
cd contracts && npm run status:devnet        # inventory, policy, pause state
curl -s localhost:3000/api/faucet/health | jq
```

### Key separation — do not skip this

Three distinct keys, three distinct jobs:

| Key | Role | Held by | Can do |
|---|---|---|---|
| **Admin / treasury** | `DEFAULT_ADMIN_ROLE`, `TREASURER_ROLE`, `PAUSER_ROLE` | Multisig or cold wallet | Change policy, deposit, withdraw, pause |
| **Deployer** | deploy only | Deploy EOA | Deploy the vault |
| **Dispenser** | `DISPENSER_ROLE` | Backend hot wallet | `dispense()` within policy — nothing else |

Generate the dispenser key separately and never reuse the deployer key:

```bash
node -e "const{Wallet}=require('ethers');const w=Wallet.createRandom();
console.log('address:',w.address);console.log('key:',w.privateKey)"
```

The dispenser is deliberately **not** granted any role in the constructor, so
custody and signing stay separate from the first block.

## Claim flow

`POST /api/faucet/claim` with `{ walletAddress, tokenSymbol, captchaToken? }`.

The pipeline runs the cheapest, most decisive checks first:

1. **Validate** the address and resolve the token (no I/O).
2. **CAPTCHA** — rejected before touching Redis or the chain.
3. **On-chain pre-checks** — paused? token enabled? inventory? cooldown?
4. **Redis wallet lock** — `SET NX`, so concurrent duplicates cannot both pass.
5. **Per-IP budget** — a sliding window per network.
6. **`vault.dispense(token, recipient, 0)`** — the only step that spends gas.

If step 6 fails, the Redis reservation is **released**, so a transient RPC error
does not lock the user out for 24 hours.

`amount` is always `0`, which tells the contract to use its own `dripAmount`. The
server never picks an amount, keeping payout size out of the trust boundary.

### Nonce safety

Every claim is signed by one key, so concurrent requests would race on the nonce.
`lib/tx-queue.ts` serialises them strictly FIFO. At faucet throughput this is both
simplest and correct, and it eliminates the `nonce too low` /
`replacement transaction underpriced` class of bugs entirely.

## Admin console — managing the vault without a block explorer

Hoodium has no explorer yet, so the console replaces one for vault operations. Open
**`/#/admin`** (there is a link in the public footer).

It reads live chain state and can do everything an operator needs:

| Panel | Actions | Role required |
|---|---|---|
| Overview | Vault address, network, unique recipients | none (read-only) |
| Operator wallet | Connect, detect wrong network, one-click chain switch, show held roles | none |
| Controls | Pause / resume dispensing, cross-token cooldown | `PAUSER_ROLE` / admin |
| Token policy | Drip, max dispense, cooldown, daily cap, enable/disable, add token | `DEFAULT_ADMIN_ROLE` |
| Inventory | Deposit RUNE, deposit ERC-20 (approve + deposit), withdraw | `TREASURER_ROLE` |
| Access control | Grant / revoke any role | `DEFAULT_ADMIN_ROLE` |
| Rescue | Recover a token that was never accepted | `DEFAULT_ADMIN_ROLE` |

### Security model of the console

- **It holds no keys.** Every write is signed by your browser wallet
  (MetaMask/Rabby/Frame). The page's own code has no signing ability, so the
  console's existence adds no attack surface — deleting it would not change the
  vault's security.
- **Roles are read for your address up front**, so actions you cannot perform are
  disabled rather than failing in the wallet.
- **The vault address comes from the API** (`/api/faucet/tokens`), so the console
  cannot be pointed at a different vault than the one the backend serves.
- **Wrong-network is a first-class state**, with a one-click switch that also
  *adds* Hoodium to the wallet when unknown (the normal case).

### The ABI is hand-written — and verified

The console cannot fetch an ABI from anywhere, so `frontend/src/lib/vaultAbi.ts`
carries it as source. That is only safe if it provably matches the contract, so:

```bash
cd contracts && npm run verify:abi
```

compares the two as canonical signatures (exactly what ethers uses for dispatch)
and exits non-zero on any drift. **Run it after every contract change.** It
requires `hardhat compile` first, since it reads the artifact.

The frontend therefore needs `npm install` (it now depends on `ethers`) before the
console will build.

## API


| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/faucet/tokens` | Network metadata, accepted tokens, live policy + inventory |
| `POST` | `/api/faucet/claim` | Request a dispense |
| `GET` | `/api/faucet/status?walletAddress=&token=` | Cooldown state for the countdown |
| `GET` | `/api/faucet/health` | Chain ID, RPC, dispenser role, pause, gas, Redis |

Error responses are uniform:

```json
{ "error": { "code": "COOLDOWN_ACTIVE",
             "message": "This wallet has already claimed RUNE.",
             "retryAfterSeconds": 82193 } }
```

| Status | Codes |
|---|---|
| 400 | `VALIDATION_FAILED`, `INVALID_ADDRESS`, `TOKEN_NOT_ACCEPTED` |
| 403 | `CAPTCHA_FAILED` |
| 429 | `COOLDOWN_ACTIVE`, `IP_LIMIT_REACHED`, `DAILY_CAP_REACHED` |
| 503 | `PAUSED`, `TOKEN_DISABLED`, `OUT_OF_INVENTORY`, `DISPENSER_NO_GAS` |
| 500 | `WRONG_CHAIN`, `DISPENSER_UNAUTHORISED` |

`retryAfterSeconds` is also sent as the standard `Retry-After` header.

## Switching to testnet

No code changes — the network table is data:

1. Set `HOODIUM_NETWORK=testnet` and `HOODIUM_TESTNET_RPC_URL` in `.env`.
2. `cd contracts && npm run deploy:testnet` (instead of `deploy:devnet`).
3. Re-seed, re-grant the dispenser, restart the backend.

The deploy script **verifies the RPC chain ID** against the network name and
refuses to run on a mismatch, so a wrong `.env` cannot deploy a faucet to the
wrong chain.

## Docker

```bash
cp .env.example .env    # fill in vault address + dispenser key
docker compose up --build
```

Three services: `redis-cache` (AOF-persisted, so cooldowns survive restarts),
`backend-api` (bound to `127.0.0.1:3000`) and `frontend` (nginx on `:8080`,
proxying `/api`). The browser stays single-origin, so no CORS setup is needed.

Contract deployment is intentionally **not** containerised: it would require the
admin key inside the image.

## Security notes

- **Never enable the `personal` JSON-RPC namespace** on a node serving this
  faucet. Hoodium excludes it by default; enabling it exposes unauthenticated
  node-side signing.
- `.env` is gitignored. If a key is ever committed, rotate it and revoke the role.
- `contracts/deployments/` is gitignored by default because it records live
  admin/dispenser addresses. Remove that rule if you want them public.
- Set a real CAPTCHA provider (`turnstile` or `recaptcha`) before exposing the
  faucet publicly. `CAPTCHA_PROVIDER=none` is for local devnet only.
- Pause rather than redeploy in an incident: `vault.pause()` stops dispensing
  instantly while still allowing inventory top-ups.

## Known limitations

- **No block explorer exists on Hoodium yet**, so verify URLs are placeholders
  and the UI links to no explorer. `etherscan.customChains` is ready for one.
- No automated backend integration tests yet; the contract suite is the
  authoritative coverage.
- The vault's `rescue()` cannot recover an *accepted* token — by design, that
  path is `withdraw()`, so accounting stays honest.
- `MockERC20` is for provisioning inventory on a devnet that has no real ERC-20.
  On testnet with real assets, skip it and deposit the real token instead.


