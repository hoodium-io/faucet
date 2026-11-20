import { expect } from "chai";
import { ethers } from "hardhat";

const DAY = 24 * 60 * 60;
const NATIVE = ethers.ZeroAddress;

async function deployFixture() {
  const [admin, treasurer, dispenser, alice, bob] = await ethers.getSigners();

  const Vault = await ethers.getContractFactory("FaucetVault");
  const vault = await Vault.deploy(admin.address);
  await vault.waitForDeployment();

  const Mock = await ethers.getContractFactory("MockERC20");
  const token = await Mock.deploy(
    "Mock USD",
    "mUSD",
    18,
    ethers.parseUnits("1000000", 18),
    0,
    treasurer.address,
  );
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();

  // Custody and signing are separate accounts by design, so both roles are
  // granted explicitly rather than relying on the constructor's grants to
  // `admin`.
  //
  // The constructor grants DEFAULT_ADMIN / TREASURER / PAUSER to `admin` only and
  // deliberately does NOT grant DISPENSER (see FaucetVault.sol). That means a
  // fixture using a *separate* `treasurer` signer must grant TREASURER_ROLE to it
  // — otherwise `depositERC20` correctly reverts with
  // AccessControlUnauthorizedAccount(treasurer, TREASURER_ROLE).
  await vault.connect(admin).grantRole(await vault.TREASURER_ROLE(), treasurer.address);
  await vault.connect(admin).grantRole(await vault.DISPENSER_ROLE(), dispenser.address);

  // Treasurer deposits inventory.
  const depositAmount = ethers.parseUnits("100000", 18);
  await token.connect(treasurer).approve(await vault.getAddress(), depositAmount);
  await vault.connect(treasurer).depositERC20(tokenAddr, depositAmount);
  await vault.connect(treasurer).depositNative({ value: ethers.parseEther("100") });

  // Admin registers policy for the ERC-20 and for native RUNE.
  await vault.connect(admin).setTokenConfig(tokenAddr, {
    enabled: true,
    dripAmount: ethers.parseUnits("100", 18),
    maxDispense: ethers.parseUnits("100", 18),
    cooldown: DAY,
    dailyCap: ethers.parseUnits("1000", 18),
  });

  await vault.connect(admin).setTokenConfig(NATIVE, {
    enabled: true,
    dripAmount: ethers.parseEther("1"),
    maxDispense: ethers.parseEther("1"),
    cooldown: DAY,
    dailyCap: ethers.parseEther("50"),
  });

  return { vault, token, tokenAddr, admin, treasurer, dispenser, alice, bob };
}

describe("FaucetVault", function () {
  describe("deployment", function () {
    it("grants admin, treasurer and pauser, but NOT dispenser", async function () {
      const { vault, admin } = await deployFixture();

      expect(await vault.hasRole(await vault.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
      expect(await vault.hasRole(await vault.TREASURER_ROLE(), admin.address)).to.equal(true);
      expect(await vault.hasRole(await vault.PAUSER_ROLE(), admin.address)).to.equal(true);
      // Custody and signing are deliberately decoupled from day one.
      expect(await vault.hasRole(await vault.DISPENSER_ROLE(), admin.address)).to.equal(false);
    });

    it("rejects a zero admin", async function () {
      const Vault = await ethers.getContractFactory("FaucetVault");
      await expect(Vault.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        Vault,
        "ZeroAddress",
      );
    });
  });

  describe("deposits", function () {
    it("accepts ERC-20 inventory from a treasurer", async function () {
      const { vault, token, tokenAddr, treasurer } = await deployFixture();
      const amount = ethers.parseUnits("500", 18);

      await token.connect(treasurer).approve(await vault.getAddress(), amount);
      await expect(vault.connect(treasurer).depositERC20(tokenAddr, amount))
        .to.emit(vault, "Deposited")
        .withArgs(tokenAddr, treasurer.address, amount);

      expect(await vault.inventory(tokenAddr)).to.equal(ethers.parseUnits("100500", 18));
    });

    it("rejects ERC-20 deposits from non-treasurers", async function () {
      const { vault, token, tokenAddr, treasurer, alice } = await deployFixture();

      // The supply was minted to `treasurer`, so the transfer must come from
      // them — calling it unconnected would run as the default signer (admin),
      // which holds no tokens and would revert with ERC20InsufficientBalance.
      await token.connect(treasurer).transfer(alice.address, ethers.parseUnits("10", 18));
      await token.connect(alice).approve(await vault.getAddress(), ethers.parseUnits("10", 18));

      await expect(
        vault.connect(alice).depositERC20(tokenAddr, ethers.parseUnits("10", 18)),
      ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });

    it("rejects stray native transfers from non-treasurers", async function () {
      const { vault, alice } = await deployFixture();

      await expect(
        alice.sendTransaction({ to: await vault.getAddress(), value: ethers.parseEther("1") }),
      ).to.be.revertedWithCustomError(vault, "DirectDepositDisabled");
    });
  });

  describe("dispense", function () {
    it("pays the configured drip to a recipient", async function () {
      const { vault, token, tokenAddr, dispenser, alice } = await deployFixture();
      const before = await token.balanceOf(alice.address);

      await expect(vault.connect(dispenser).dispense(tokenAddr, alice.address, 0))
        .to.emit(vault, "Dispensed")
        .withArgs(tokenAddr, alice.address, ethers.parseUnits("100", 18), dispenser.address);

      expect(await token.balanceOf(alice.address)).to.equal(before + ethers.parseUnits("100", 18));
    });

    it("pays native RUNE when NATIVE_TOKEN is requested", async function () {
      const { vault, dispenser, alice } = await deployFixture();
      const before = await ethers.provider.getBalance(alice.address);

      await vault.connect(dispenser).dispense(NATIVE, alice.address, 0);

      expect(await ethers.provider.getBalance(alice.address)).to.equal(
        before + ethers.parseEther("1"),
      );
    });

    it("rejects callers without DISPENSER_ROLE", async function () {
      const { vault, tokenAddr, alice, bob } = await deployFixture();

      await expect(
        vault.connect(alice).dispense(tokenAddr, bob.address, 0),
      ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });

    it("enforces the per-recipient cooldown", async function () {
      const { vault, tokenAddr, dispenser, alice } = await deployFixture();

      await vault.connect(dispenser).dispense(tokenAddr, alice.address, 0);

      await expect(
        vault.connect(dispenser).dispense(tokenAddr, alice.address, 0),
      ).to.be.revertedWithCustomError(vault, "CooldownActive");
    });

    it("allows a second claim once the cooldown elapses", async function () {
      const { vault, tokenAddr, dispenser, alice } = await deployFixture();

      await vault.connect(dispenser).dispense(tokenAddr, alice.address, 0);
      await ethers.provider.send("evm_increaseTime", [DAY + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(vault.connect(dispenser).dispense(tokenAddr, alice.address, 0)).to.emit(
        vault,
        "Dispensed",
      );
    });

    it("caps a single dispense at maxDispense", async function () {
      const { vault, tokenAddr, dispenser, alice } = await deployFixture();

      await expect(
        vault.connect(dispenser).dispense(tokenAddr, alice.address, ethers.parseUnits("101", 18)),
      ).to.be.revertedWithCustomError(vault, "AmountExceedsMaxDispense");
    });

    it("rejects an unregistered token", async function () {
      const { vault, dispenser, alice } = await deployFixture();

      await expect(
        vault.connect(dispenser).dispense(alice.address, alice.address, 0),
      ).to.be.revertedWithCustomError(vault, "TokenNotAccepted");
    });

    it("rejects a disabled token", async function () {
      const { vault, tokenAddr, admin, dispenser, alice } = await deployFixture();

      await vault.connect(admin).setTokenEnabled(tokenAddr, false);

      await expect(
        vault.connect(dispenser).dispense(tokenAddr, alice.address, 0),
      ).to.be.revertedWithCustomError(vault, "TokenDisabled");
    });

    it("rejects a zero recipient and the vault itself", async function () {
      const { vault, tokenAddr, dispenser } = await deployFixture();

      await expect(
        vault.connect(dispenser).dispense(tokenAddr, ethers.ZeroAddress, 0),
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");

      await expect(
        vault.connect(dispenser).dispense(tokenAddr, await vault.getAddress(), 0),
      ).to.be.revertedWithCustomError(vault, "RecipientIsVault");
    });

    it("enforces the rolling daily cap", async function () {
      const { vault, tokenAddr, dispenser, alice, bob } = await deployFixture();

      // Cap is 1000 and each claim is 100, so ten recipients exhaust it exactly.
      const recipients = Array.from({ length: 10 }, () => ethers.Wallet.createRandom().address);
      for (const r of recipients) {
        await vault.connect(dispenser).dispense(tokenAddr, r, 0);
      }

      await expect(
        vault.connect(dispenser).dispense(tokenAddr, alice.address, 0),
      ).to.be.revertedWithCustomError(vault, "DailyCapExceeded");

      // A fresh window restores capacity.
      await ethers.provider.send("evm_increaseTime", [DAY + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(vault.connect(dispenser).dispense(tokenAddr, bob.address, 0)).to.emit(
        vault,
        "Dispensed",
      );
    });

    it("reverts when inventory is insufficient", async function () {
      const { vault, admin, dispenser, alice } = await deployFixture();

      const Empty = await ethers.getContractFactory("MockERC20");
      const empty = await Empty.deploy("Empty", "EMP", 18, 0, 0, admin.address);
      await empty.waitForDeployment();
      const emptyAddr = await empty.getAddress();

      await vault.connect(admin).setTokenConfig(emptyAddr, {
        enabled: true,
        dripAmount: ethers.parseUnits("1", 18),
        maxDispense: ethers.parseUnits("1", 18),
        cooldown: 0,
        dailyCap: 0,
      });

      await expect(
        vault.connect(dispenser).dispense(emptyAddr, alice.address, 0),
      ).to.be.revertedWithCustomError(vault, "InsufficientInventory");
    });

    it("blocks dispensing while paused but still accepts inventory", async function () {
      const { vault, token, tokenAddr, admin, treasurer, dispenser, alice } = await deployFixture();

      await vault.connect(admin).pause();

      await expect(
        vault.connect(dispenser).dispense(tokenAddr, alice.address, 0),
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");

      // Topping up must remain possible during an incident.
      const amount = ethers.parseUnits("10", 18);
      await token.connect(treasurer).approve(await vault.getAddress(), amount);
      await expect(vault.connect(treasurer).depositERC20(tokenAddr, amount)).to.emit(
        vault,
        "Deposited",
      );

      await vault.connect(admin).unpause();
      await expect(vault.connect(dispenser).dispense(tokenAddr, alice.address, 0)).to.emit(
        vault,
        "Dispensed",
      );
    });

    it("counts each unique recipient exactly once", async function () {
      const { vault, tokenAddr, dispenser, alice } = await deployFixture();

      await vault.connect(dispenser).dispense(tokenAddr, alice.address, 0);
      expect(await vault.uniqueRecipients()).to.equal(1);

      await ethers.provider.send("evm_increaseTime", [DAY + 1]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(dispenser).dispense(tokenAddr, alice.address, 0);

      expect(await vault.uniqueRecipients()).to.equal(1);
    });
  });

  describe("configuration", function () {
    it("only lets the admin set token config", async function () {
      const { vault, tokenAddr, dispenser } = await deployFixture();

      await expect(
        vault.connect(dispenser).setTokenConfig(tokenAddr, {
          enabled: true,
          dripAmount: 1n,
          maxDispense: 1n,
          cooldown: 0,
          dailyCap: 0,
        }),
      ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });

    it("rejects a drip larger than maxDispense", async function () {
      const { vault, tokenAddr, admin } = await deployFixture();

      await expect(
        vault.connect(admin).setTokenConfig(tokenAddr, {
          enabled: true,
          dripAmount: ethers.parseUnits("200", 18),
          maxDispense: ethers.parseUnits("100", 18),
          cooldown: 0,
          dailyCap: 0,
        }),
      ).to.be.revertedWithCustomError(vault, "InvalidConfig");
    });

    it("rejects a maxDispense of zero", async function () {
      const { vault, tokenAddr, admin } = await deployFixture();

      await expect(
        vault.connect(admin).setTokenConfig(tokenAddr, {
          enabled: false,
          dripAmount: 0,
          maxDispense: 0,
          cooldown: 0,
          dailyCap: 0,
        }),
      ).to.be.revertedWithCustomError(vault, "InvalidConfig");
    });

    it("applies the cross-token address cooldown", async function () {
      const { vault, tokenAddr, admin, dispenser, alice } = await deployFixture();

      await vault.connect(admin).setAddressCooldown(DAY);
      await vault.connect(dispenser).dispense(tokenAddr, alice.address, 0);

      // A different token must still respect the address-wide cooldown.
      await expect(
        vault.connect(dispenser).dispense(NATIVE, alice.address, 0),
      ).to.be.revertedWithCustomError(vault, "CooldownActive");
    });
  });

  describe("withdraw and rescue", function () {
    it("lets a treasurer withdraw accepted inventory", async function () {
      const { vault, token, tokenAddr, treasurer } = await deployFixture();
      const amount = ethers.parseUnits("1000", 18);
      const before = await token.balanceOf(treasurer.address);

      await vault.connect(treasurer).withdraw(tokenAddr, treasurer.address, amount);

      expect(await token.balanceOf(treasurer.address)).to.equal(before + amount);
    });

    it("refuses to rescue an accepted token", async function () {
      const { vault, tokenAddr, admin } = await deployFixture();

      await expect(
        vault.connect(admin).rescue(tokenAddr, admin.address, ethers.parseUnits("1", 18)),
      ).to.be.revertedWithCustomError(vault, "TokenIsAccepted");
    });

    it("rescues a token that was never accepted", async function () {
      const { vault, admin, alice } = await deployFixture();

      const Stray = await ethers.getContractFactory("MockERC20");
      const stray = await Stray.deploy(
        "Stray",
        "STR",
        18,
        ethers.parseUnits("50", 18),
        0,
        admin.address,
      );
      await stray.waitForDeployment();
      const strayAddr = await stray.getAddress();

      await stray.transfer(await vault.getAddress(), ethers.parseUnits("10", 18));

      await expect(
        vault.connect(admin).rescue(strayAddr, alice.address, ethers.parseUnits("10", 18)),
      ).to.emit(vault, "Rescued");

      expect(await stray.balanceOf(alice.address)).to.equal(ethers.parseUnits("10", 18));
    });
  });

  describe("views", function () {
    it("exposes accepted tokens and token status", async function () {
      const { vault, tokenAddr } = await deployFixture();

      const tokens = await vault.acceptedTokens();
      expect(tokens).to.include(tokenAddr);
      expect(tokens).to.include(NATIVE);

      const status = await vault.tokenStatus(tokenAddr);
      expect(status[0].enabled).to.equal(true);
      expect(status[1]).to.equal(ethers.parseUnits("100000", 18));
      expect(status[3]).to.equal(ethers.parseUnits("1000", 18));
    });

    it("reports claimability", async function () {
      const { vault, tokenAddr, dispenser, alice } = await deployFixture();

      let result = await vault.claimableAt(tokenAddr, alice.address);
      expect(result[0]).to.equal(true);

      await vault.connect(dispenser).dispense(tokenAddr, alice.address, 0);

      result = await vault.claimableAt(tokenAddr, alice.address);
      expect(result[0]).to.equal(false);
      expect(result[1]).to.be.greaterThan(0n);
    });
  });
});
