// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title  FaucetVault
/// @notice Custody vault for a Hoodium Network testnet faucet.
///
/// @dev    This contract is the **single custody point** for every token the
///         faucet distributes. The architecture is the standard "deposit vault
///         + authorised dispense" faucet pattern, NOT a minting faucet:
///
///         - Tokens are **deposited** here by a treasurer (`TREASURER_ROLE`).
///           Nothing is minted here, ever.
///         - Tokens are **dispensed** from here by a backend-operated account
///           (`DISPENSER_ROLE`), the only party that can authorise a claim. The
///           backend cannot mint either; it can only move existing inventory.
///         - Users never interact with the token contracts and never call this
///           contract. They only ever receive a transfer.
///
///         Enforcement is split into two layers on purpose (defence in depth):
///
///         | Layer     | Enforces |
///         |-----------|----------|
///         | On-chain  | drip size, per-recipient cooldown, cross-token cooldown, rolling 24h cap, inventory |
///         | Off-chain | CAPTCHA, IP rate limits, Redis cooldowns, per-network policy |
///
///         The on-chain limits are authoritative: they hold even if the backend
///         is compromised and its dispenser key is stolen. The worst a stolen
///         dispenser key can achieve is draining inventory within the caps.
///
///         Hoodium specifics this contract is built around:
///         - The gas token is native **RUNE** (`arune`, 18 decimals), reachable
///           here through the `NATIVE_TOKEN` sentinel so the faucet can hand out
///           gas money as well as ERC-20s.
///         - Test tokens on Hoodium are ordinary ERC-20s. `SafeERC20` is used so
///           non-standard (no-return) tokens are also supported.
///         - Amounts are raw base units. Decimal scaling is the backend's job.
contract FaucetVault is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    /// @notice Sentinel used to refer to the chain's native gas token.
    /// @dev    `address(0)` can never be a real ERC-20, so it is a safe marker.
    address public constant NATIVE_TOKEN = address(0);

    /// @notice May call `dispense`. Held by the backend's hot account.
    bytes32 public constant DISPENSER_ROLE = keccak256("DISPENSER_ROLE");

    /// @notice May deposit and withdraw inventory.
    bytes32 public constant TREASURER_ROLE = keccak256("TREASURER_ROLE");

    /// @notice May pause and unpause dispensing.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Length of the rolling accounting window used by `dailyCap`.
    uint256 public constant DAY = 1 days;

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    /// @notice Per-token distribution policy.
    /// @param enabled     Whether this token can currently be dispensed.
    /// @param dripAmount  Default amount per claim, in base units.
    /// @param maxDispense Hard ceiling on any single dispense.
    /// @param cooldown    Seconds a recipient waits before claiming this token again.
    /// @param dailyCap    Max dispensed per rolling 24h window (0 = uncapped).
    struct TokenConfig {
        bool enabled;
        uint256 dripAmount;
        uint256 maxDispense;
        uint32 cooldown;
        uint256 dailyCap;
    }

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    /// @notice Per-token policy.
    mapping(address token => TokenConfig) public tokenConfig;

    /// @notice Tokens that have ever been accepted, for UI enumeration.
    /// @dev    Append-only. Disabling sets `enabled = false` but keeps the entry
    ///         so the UI can explain why the token is unavailable.
    address[] private _acceptedTokens;

    /// @notice Whether a token is already present in `_acceptedTokens`.
    mapping(address token => bool) private _listed;

    /// @notice Last time `recipient` claimed `token`.
    mapping(address token => mapping(address recipient => uint256)) public lastClaimAt;

    /// @notice Last time `recipient` claimed any token (cross-token cooldown).
    mapping(address recipient => uint256) public lastClaimAtAnyToken;

    /// @notice Rolling-window bookkeeping per token.
    mapping(address token => uint256) public windowStart;
    mapping(address token => uint256) public dispensedInWindow;

    /// @notice Lifetime amount dispensed per token (observability).
    mapping(address token => uint256) public totalDispensed;

    /// @notice Seconds a recipient must wait between claims of *different* tokens.
    /// @dev    `0` disables it. When set, it stops one address from walking the
    ///         whole token list in a single block.
    uint32 public addressCooldown;

    /// @notice Number of distinct recipients that have claimed at least once.
    uint256 public uniqueRecipients;

    /// @notice Recipients already counted in `uniqueRecipients`.
    mapping(address recipient => bool) private _seenRecipient;

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error TokenNotAccepted(address token);
    error TokenDisabled(address token);
    error AmountExceedsMaxDispense(uint256 amount, uint256 maxDispense);
    error CooldownActive(uint256 availableAt);
    error DailyCapExceeded(uint256 requested, uint256 remaining);
    error InsufficientInventory(address token, uint256 requested, uint256 available);
    error InvalidConfig();
    error RecipientIsVault();
    error DirectDepositDisabled();
    error NativeTransferFailed(address to, uint256 amount);
    error TokenIsAccepted(address token);

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event Deposited(address indexed token, address indexed from, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event Dispensed(
        address indexed token,
        address indexed recipient,
        uint256 amount,
        address indexed operator
    );
    event TokenConfigUpdated(address indexed token, TokenConfig config);
    event AddressCooldownUpdated(uint32 cooldown);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    // ------------------------------------------------------------------
    // Construction
    // ------------------------------------------------------------------

    /// @param admin Address granted every role at deploy time. Use a multisig
    ///        or treasury EOA; the backend dispenser key is granted separately.
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(TREASURER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        // NOTE: DISPENSER_ROLE is deliberately NOT granted to the admin here.
        // The dispenser is a hot backend key; it must be granted explicitly via
        // `grantRole(DISPENSER_ROLE, backendAddress)` so custody and signing are
        // separate concerns from day one.
    }

    /// @notice Accepts native RUNE sent by a treasurer.
    /// @dev    Restricted to `TREASURER_ROLE`: a vault that silently accepts
    ///         stray value invites accidental loss. Use `depositNative` when you
    ///         want the indexed event; this fallback exists for simple sends.
    receive() external payable {
        if (!hasRole(TREASURER_ROLE, msg.sender)) revert DirectDepositDisabled();
        emit Deposited(NATIVE_TOKEN, msg.sender, msg.value);
    }

    // ------------------------------------------------------------------
    // Inventory management (treasurer)
    // ------------------------------------------------------------------

    /// @notice Deposits `amount` of an ERC-20 into the vault.
    /// @dev    Caller must have approved this contract for `amount` first.
    ///         Deposit is allowed while paused so inventory can be topped up
    ///         during an incident.
    /// @param token  ERC-20 contract address.
    /// @param amount Amount in base units.
    function depositERC20(address token, uint256 amount) external onlyRole(TREASURER_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        // Measure the actual delta so fee-on-transfer tokens are accounted for
        // by what the vault really received, not what the caller claimed.
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;

        if (received == 0) revert ZeroAmount();

        _registerTokenIfNeeded(token);
        emit Deposited(token, msg.sender, received);
    }

    /// @notice Deposits native RUNE into the vault.
    function depositNative() external payable onlyRole(TREASURER_ROLE) {
        if (msg.value == 0) revert ZeroAmount();

        _registerTokenIfNeeded(NATIVE_TOKEN);
        emit Deposited(NATIVE_TOKEN, msg.sender, msg.value);
    }

    /// @notice Withdraws inventory back out (treasury recovery).
    /// @dev    Available to treasurers, and `token` may be `NATIVE_TOKEN`.
    function withdraw(address token, address to, uint256 amount)
        external
        onlyRole(TREASURER_ROLE)
        nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        _payout(token, to, amount);
        emit Withdrawn(token, to, amount);
    }

    // ------------------------------------------------------------------
    // Distribution
    // ------------------------------------------------------------------

    /// @notice Dispenses test tokens to `recipient`.
    /// @dev    The single authorisation point for a claim. Called by the backend
    ///         dispenser after CAPTCHA and IP/Redis checks pass, but every limit
    ///         below is enforced on-chain regardless of the caller.
    ///
    ///         Effects ordering: all limits are checked and all state is written
    ///         **before** the external payout, and `nonReentrant` guards the
    ///         transfer, so checks-effects-interactions holds.
    ///
    /// @param token     Token to dispense (`NATIVE_TOKEN` for native RUNE).
    /// @param recipient Recipient wallet address.
    /// @param amount    Amount in base units; pass `0` to use `dripAmount`.
    /// @return paid     The amount actually transferred.
    function dispense(address token, address recipient, uint256 amount)
        external
        onlyRole(DISPENSER_ROLE)
        whenNotPaused
        nonReentrant
        returns (uint256 paid)
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (recipient == address(this)) revert RecipientIsVault();

        TokenConfig memory cfg = tokenConfig[token];
        if (!_listed[token]) revert TokenNotAccepted(token);
        if (!cfg.enabled) revert TokenDisabled(token);

        // `amount == 0` means "use the configured drip".
        paid = amount == 0 ? cfg.dripAmount : amount;
        if (paid == 0) revert ZeroAmount();

        // A caller-supplied amount may not exceed the ceiling, so a compromised
        // dispenser key cannot overdraw in one transaction.
        if (paid > cfg.maxDispense) revert AmountExceedsMaxDispense(paid, cfg.maxDispense);

        _enforceCooldowns(token, recipient, cfg.cooldown);
        _enforceDailyCap(token, paid, cfg.dailyCap);
        _checkInventory(token, paid);

        // --- Effects ---
        lastClaimAt[token][recipient] = block.timestamp;
        lastClaimAtAnyToken[recipient] = block.timestamp;
        totalDispensed[token] += paid;

        if (cfg.dailyCap != 0) {
            dispensedInWindow[token] += paid;
        }

        if (!_seenRecipient[recipient]) {
            _seenRecipient[recipient] = true;
            uniqueRecipients += 1;
        }

        emit Dispensed(token, recipient, paid, msg.sender);

        // --- Interaction (last) ---
        _payout(token, recipient, paid);
    }

    // ------------------------------------------------------------------
    // Configuration (admin)
    // ------------------------------------------------------------------

    /// @notice Adds or updates an accepted token and its policy.
    /// @param token  Token address, or `NATIVE_TOKEN` for native RUNE.
    /// @param cfg    Policy. `maxDispense` must be > 0 and `dripAmount` may not
    ///               exceed it.
    function setTokenConfig(address token, TokenConfig calldata cfg)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        // The vault itself is never a dispensed token; that would be nonsense
        // rather than a zero address, so it gets its own guard.
        if (token == address(this)) revert InvalidConfig();
        // A token with no ceiling can never dispense, so treat that combination
        // as a configuration mistake rather than a silent disable.
        if (cfg.maxDispense == 0) revert InvalidConfig();
        if (cfg.enabled && cfg.dripAmount > cfg.maxDispense) revert InvalidConfig();

        tokenConfig[token] = cfg;
        _registerTokenIfNeeded(token);

        emit TokenConfigUpdated(token, cfg);
    }

    /// @notice Enables or disables dispensing of a token without touching the
    ///         rest of its policy.
    function setTokenEnabled(address token, bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!_listed[token]) revert TokenNotAccepted(token);

        tokenConfig[token].enabled = enabled;
        emit TokenConfigUpdated(token, tokenConfig[token]);
    }

    /// @notice Sets the cross-token cooldown applied to every recipient.
    function setAddressCooldown(uint32 cooldown) external onlyRole(DEFAULT_ADMIN_ROLE) {
        addressCooldown = cooldown;
        emit AddressCooldownUpdated(cooldown);
    }

    /// @notice Pauses dispensing. Inventory deposits remain possible.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resumes dispensing.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Emergency extraction for a token that was sent here by mistake
    ///         and was never configured as an accepted token.
    /// @dev    Deliberately refuses to touch accepted tokens: those are governed
    ///         by the per-token policy and must move through `withdraw` so the
    ///         accounting stays honest.
    function rescue(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        // Uses its own error rather than `TokenNotAccepted`, which would read as
        // the opposite of what happened.
        if (_listed[token]) revert TokenIsAccepted(token);

        _payout(token, to, amount);
        emit Rescued(token, to, amount);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice Returns every token ever accepted, including disabled ones.
    function acceptedTokens() external view returns (address[] memory) {
        return _acceptedTokens;
    }

    /// @notice Returns how much inventory the vault currently holds.
    function inventory(address token) public view returns (uint256) {
        if (token == NATIVE_TOKEN) {
            return address(this).balance;
        }
        return IERC20(token).balanceOf(address(this));
    }

    /// @notice Full policy plus live state for one token, in a single call.
    /// @dev    Exists so the frontend can render the selector and countdowns
    ///         with one `eth_call` per token instead of six.
    /// @return cfg           Current policy.
    /// @return available     Inventory held by the vault.
    /// @return dispensedToday Amount already dispensed in the current window.
    /// @return remainingToday What is left of `dailyCap` (0 when uncapped).
    function tokenStatus(address token)
        external
        view
        returns (TokenConfig memory cfg, uint256 available, uint256 dispensedToday, uint256 remainingToday)
    {
        cfg = tokenConfig[token];
        available = inventory(token);

        (uint256 start, uint256 used) = _currentWindow(token);
        // Report the window as of now: if it has rolled over, nothing is used.
        dispensedToday = start == 0 ? 0 : used;

        if (cfg.dailyCap == 0) {
            remainingToday = 0;
        } else {
            remainingToday = dispensedToday >= cfg.dailyCap ? 0 : cfg.dailyCap - dispensedToday;
        }
    }

    /// @notice Whether `recipient` may claim `token` right now, and when it can.
    /// @return allowed     True if a claim would pass the cooldown checks.
    /// @return availableAt Unix timestamp when the claim becomes possible.
    function claimableAt(address token, address recipient)
        external
        view
        returns (bool allowed, uint256 availableAt)
    {
        availableAt = _cooldownEndsAt(token, recipient, tokenConfig[token].cooldown);
        allowed = availableAt <= block.timestamp;
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    /// @dev Adds `token` to the enumeration list once.
    function _registerTokenIfNeeded(address token) private {
        if (_listed[token]) return;

        _listed[token] = true;
        _acceptedTokens.push(token);
    }

    /// @dev Returns the active rolling window for `token`, resetting it lazily
    ///      once `DAY` has elapsed. State is only mutated when a dispense
    ///      actually happens, so the view path stays read-only.
    function _currentWindow(address token) private view returns (uint256 start, uint256 used) {
        start = windowStart[token];
        if (start == 0 || block.timestamp >= start + DAY) {
            return (0, 0);
        }
        return (start, dispensedInWindow[token]);
    }

    /// @dev Reverts when either the per-token or cross-token cooldown is active.
    function _enforceCooldowns(address token, address recipient, uint32 tokenCooldown) private view {
        uint256 availableAt = _cooldownEndsAt(token, recipient, tokenCooldown);
        if (availableAt > block.timestamp) revert CooldownActive(availableAt);
    }

    /// @dev Latest timestamp at which every cooldown for this claim expires.
    function _cooldownEndsAt(address token, address recipient, uint32 tokenCooldown)
        private
        view
        returns (uint256 endsAt)
    {
        if (tokenCooldown != 0) {
            uint256 last = lastClaimAt[token][recipient];
            if (last != 0) {
                endsAt = last + tokenCooldown;
            }
        }

        if (addressCooldown != 0) {
            uint256 lastAny = lastClaimAtAnyToken[recipient];
            if (lastAny != 0) {
                uint256 addressEndsAt = lastAny + addressCooldown;
                if (addressEndsAt > endsAt) endsAt = addressEndsAt;
            }
        }
    }

    /// @dev Rolls the window if needed, then reverts if `amount` would breach it.
    function _enforceDailyCap(address token, uint256 amount, uint256 cap) private {
        if (cap == 0) return;

        uint256 start = windowStart[token];
        if (start == 0 || block.timestamp >= start + DAY) {
            // A dispense opens a fresh window; nothing is counted yet.
            windowStart[token] = block.timestamp;
            dispensedInWindow[token] = 0;
        }

        uint256 used = dispensedInWindow[token];
        uint256 remaining = used >= cap ? 0 : cap - used;
        if (amount > remaining) revert DailyCapExceeded(amount, remaining);
    }

    /// @dev Reverts when the vault cannot cover `amount`.
    function _checkInventory(address token, uint256 amount) private view {
        uint256 available = inventory(token);
        if (available < amount) revert InsufficientInventory(token, amount, available);
    }

    /// @dev Single exit point for value movement, so native and ERC-20 paths
    ///      cannot drift apart.
    function _payout(address token, address to, uint256 amount) private {
        if (token == NATIVE_TOKEN) {
            // slither-disable-next-line arbitrary-send-eth
            (bool ok, ) = payable(to).call{value: amount}("");
            // A failed native send is a transfer failure, not a missing balance:
            // reporting it as `InsufficientInventory` would misdiagnose a
            // recipient contract that rejects value.
            if (!ok) revert NativeTransferFailed(to, amount);
            return;
        }

        IERC20(token).safeTransfer(to, amount);
    }
}
