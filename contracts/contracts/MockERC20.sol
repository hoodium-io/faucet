// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title  MockERC20
/// @notice A plain, configurable ERC-20 used **only** to create testnet inventory.
///
/// @dev    Read this before assuming it is part of the claim path: it is not.
///
///         The faucet never mints at claim time. This contract exists so that a
///         devnet/testnet has something to *deposit into* `FaucetVault` when no
///         real ERC-20 exists yet. The intended flow is:
///
///             1. Deploy `MockERC20` (name/symbol/decimals of your choosing).
///             2. Mint a supply to a **treasury** address.
///             3. `treasury.approve(vault); vault.depositERC20(token, amount)`.
///             4. Users claim from the vault. No minting is involved.
///
///         `mint` is therefore an **inventory-provisioning** function owned by a
///         treasury/multisig, not a user-facing one. On a real network where the
///         asset already exists (for example an ERC-20 with a fixed supply),
///         skip this contract entirely and deposit the real token instead.
contract MockERC20 is ERC20, ERC20Permit, Ownable {
    /// @notice Token decimals. Immutable so the faucet's scaling is stable.
    uint8 private immutable _decimals;

    /// @notice Optional hard cap on total supply. `0` means uncapped.
    /// @dev    Set a cap for anything meant to behave like a real asset; leave it
    ///         `0` for throwaway devnet tokens.
    uint256 public immutable cap;

    error CapExceeded(uint256 requested, uint256 remaining);
    error ZeroAddress();

    /// @param name_        Token name, e.g. "Mock USD".
    /// @param symbol_      Token symbol, e.g. "mUSD".
    /// @param decimals_    Decimals, e.g. 18 (RUNE) or 6 (USDC-style).
    /// @param initialSupply Base units minted to `owner_` at deploy time.
    /// @param cap_         Hard supply cap in base units; `0` for uncapped.
    /// @param owner_       Treasury that receives the initial supply and holds
    ///                     the mint right.
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 initialSupply,
        uint256 cap_,
        address owner_
    ) ERC20(name_, symbol_) ERC20Permit(name_) Ownable(owner_) {
        if (owner_ == address(0)) revert ZeroAddress();

        _decimals = decimals_;
        cap = cap_;

        if (initialSupply != 0) {
            _mintChecked(owner_, initialSupply);
        }
    }

    /// @inheritdoc ERC20
    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Mints `amount` to `to`. Treasury-only inventory provisioning.
    /// @dev    Owner is expected to be a multisig or treasury EOA, never the
    ///         faucet backend. The backend has no mint right anywhere in this
    ///         system.
    function mint(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        _mintChecked(to, amount);
    }

    /// @notice Burns `amount` from the caller. Useful for cleaning up test supply.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    /// @dev Enforces `cap` when one is set.
    function _mintChecked(address to, uint256 amount) private {
        if (cap != 0) {
            uint256 remaining = totalSupply() >= cap ? 0 : cap - totalSupply();
            if (amount > remaining) revert CapExceeded(amount, remaining);
        }
        _mint(to, amount);
    }
}
