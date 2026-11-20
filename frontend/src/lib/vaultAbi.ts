/**
 * `FaucetVault` ABI, hand-written in ethers' human-readable format.
 *
 * WHY HAND-WRITTEN: Hoodium has no block explorer and no verification service, so
 * the admin console cannot fetch an ABI from anywhere. The options were (a) import
 * the Hardhat artifact — which only exists after `hardhat compile`, coupling the
 * frontend build to the contracts build; or (b) keep the ABI here as source.
 * (b) is better: the frontend builds independently, and correctness is *checked*
 * against the real artifact by `contracts/scripts/verify-abi.ts` rather than
 * assumed.
 *
 * This file MUST stay in lockstep with `contracts/contracts/FaucetVault.sol`.
 * After any contract change, run:
 *
 *   cd contracts && npm run verify:abi
 *
 * It diffs this list against `artifacts/contracts/FaucetVault.sol/FaucetVault.json`
 * and fails on any missing/extra function, event, error or changed signature.
 */

/** Role identifiers, mirroring the `bytes32 public constant` values. */
export const ROLES = {
  ADMIN: "DEFAULT_ADMIN_ROLE",
  DISPENSER: "DISPENSER_ROLE",
  TREASURER: "TREASURER_ROLE",
  PAUSER: "PAUSER_ROLE",
} as const;

export type RoleName = (typeof ROLES)[keyof typeof ROLES];

/**
 * Sentinel the contract uses for the native gas token (RUNE).
 * `address(0)` is never a real ERC-20, so it is unambiguous.
 */
export const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";

export const FAUCET_VAULT_ABI = [
  // ------------------------------------------------------------------
  // Constructor / receive
  // ------------------------------------------------------------------
  // Included so the console can distinguish deployment metadata from a call and
  // because `receive()` being treasurer-gated is behaviour worth surfacing.
  "constructor(address admin)",
  "receive() payable",

  // ------------------------------------------------------------------
  // Roles and constants
  // ------------------------------------------------------------------
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function DISPENSER_ROLE() view returns (bytes32)",
  "function TREASURER_ROLE() view returns (bytes32)",
  "function PAUSER_ROLE() view returns (bytes32)",
  "function NATIVE_TOKEN() view returns (address)",
  "function DAY() view returns (uint256)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function getRoleAdmin(bytes32 role) view returns (bytes32)",
  "function grantRole(bytes32 role, address account)",
  "function revokeRole(bytes32 role, address account)",
  "function renounceRole(bytes32 role, address callerConfirmation)",
  // ERC-165, inherited from AccessControl.
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",

  // ------------------------------------------------------------------
  // Inventory management (TREASURER_ROLE)
  // ------------------------------------------------------------------
  "function depositERC20(address token, uint256 amount)",
  "function depositNative() payable",
  "function withdraw(address token, address to, uint256 amount)",

  // ------------------------------------------------------------------
  // Distribution (DISPENSER_ROLE)
  // ------------------------------------------------------------------
  "function dispense(address token, address recipient, uint256 amount) returns (uint256)",

  // ------------------------------------------------------------------
  // Configuration (DEFAULT_ADMIN_ROLE)
  // ------------------------------------------------------------------
  "function setTokenConfig(address token, tuple(bool enabled, uint256 dripAmount, uint256 maxDispense, uint32 cooldown, uint256 dailyCap) cfg)",
  "function setTokenEnabled(address token, bool enabled)",
  "function setAddressCooldown(uint32 cooldown)",

  // ------------------------------------------------------------------
  // Pause (PAUSER_ROLE)
  // ------------------------------------------------------------------
  "function pause()",
  "function unpause()",
  "function paused() view returns (bool)",

  // ------------------------------------------------------------------
  // Recovery (DEFAULT_ADMIN_ROLE)
  // ------------------------------------------------------------------
  "function rescue(address token, address to, uint256 amount)",

  // ------------------------------------------------------------------
  // Views
  // ------------------------------------------------------------------
  "function acceptedTokens() view returns (address[])",
  "function inventory(address token) view returns (uint256)",
  "function tokenConfig(address token) view returns (bool enabled, uint256 dripAmount, uint256 maxDispense, uint32 cooldown, uint256 dailyCap)",
  "function tokenStatus(address token) view returns (tuple(bool enabled, uint256 dripAmount, uint256 maxDispense, uint32 cooldown, uint256 dailyCap) cfg, uint256 available, uint256 dispensedToday, uint256 remainingToday)",
  "function claimableAt(address token, address recipient) view returns (bool allowed, uint256 availableAt)",
  "function lastClaimAt(address token, address recipient) view returns (uint256)",
  "function lastClaimAtAnyToken(address recipient) view returns (uint256)",
  "function totalDispensed(address token) view returns (uint256)",
  "function dispensedInWindow(address token) view returns (uint256)",
  "function windowStart(address token) view returns (uint256)",
  "function addressCooldown() view returns (uint32)",
  "function uniqueRecipients() view returns (uint256)",

  // ------------------------------------------------------------------
  // Events
  // ------------------------------------------------------------------
  "event Deposited(address indexed token, address indexed from, uint256 amount)",
  "event Withdrawn(address indexed token, address indexed to, uint256 amount)",
  "event Dispensed(address indexed token, address indexed recipient, uint256 amount, address indexed operator)",
  "event TokenConfigUpdated(address indexed token, tuple(bool enabled, uint256 dripAmount, uint256 maxDispense, uint32 cooldown, uint256 dailyCap) config)",
  "event AddressCooldownUpdated(uint32 cooldown)",
  "event Rescued(address indexed token, address indexed to, uint256 amount)",

  // Inherited from AccessControl — emitted by the console's grant/revoke actions.
  "event RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)",
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",

  // Inherited from Pausable — emitted by the console's pause/resume actions.
  "event Paused(address account)",
  "event Unpaused(address account)",

  // ------------------------------------------------------------------
  // Errors
  // ------------------------------------------------------------------
  "error ZeroAddress()",
  "error ZeroAmount()",
  "error TokenNotAccepted(address token)",
  "error TokenDisabled(address token)",
  "error AmountExceedsMaxDispense(uint256 amount, uint256 maxDispense)",
  "error CooldownActive(uint256 availableAt)",
  "error DailyCapExceeded(uint256 requested, uint256 remaining)",
  "error InsufficientInventory(address token, uint256 requested, uint256 available)",
  "error InvalidConfig()",
  "error RecipientIsVault()",
  "error DirectDepositDisabled()",
  "error NativeTransferFailed(address to, uint256 amount)",
  "error TokenIsAccepted(address token)",

  // ------------------------------------------------------------------
  // OpenZeppelin errors surfacing through AccessControl / Pausable / SafeERC20
  // ------------------------------------------------------------------
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
  "error AccessControlBadConfirmation()",
  "error EnforcedPause()",
  "error ExpectedPause()",
  "error ReentrancyGuardReentrantCall()",
  "error SafeERC20FailedOperation(address token)",
] as const;

/** Minimal ERC-20 surface the admin console needs for balances and approvals. */
export const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
] as const;

/** A token's policy, as returned by `tokenConfig`. */
export interface TokenConfigView {
  enabled: boolean;
  dripAmount: bigint;
  maxDispense: bigint;
  cooldown: bigint;
  dailyCap: bigint;
}

/** Combined policy + live state, as returned by `tokenStatus`. */
export interface TokenStatusView {
  config: TokenConfigView;
  available: bigint;
  dispensedToday: bigint;
  remainingToday: bigint;
}

/** An accepted token with the metadata needed to render it. */
export interface AcceptedToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  isNative: boolean;
}
