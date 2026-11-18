import "dotenv/config";
import { buildApp } from "./app";

/**
 * Process entrypoint.
 *
 * Startup does a fail-fast preflight against the chain before accepting traffic.
 * A faucet that boots "healthy" while pointed at the wrong network or holding an
 * unauthorised dispenser key is worse than one that refuses to start: it accepts
 * user claims that then fail, and hides a misconfiguration behind a 200.
 */
async function main(): Promise<void> {
  const { app, config, vault, shutdown } = buildApp();

  // --- Preflight ---
  const chainId = await vault.assertCorrectChain().catch((error: unknown) => {
    console.error(`[preflight] chain check failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });

  const authorised = await vault.assertDispenserAuthorised();
  const paused = await vault.isPaused();
  const gas = await vault.dispenserGasBalance();

  console.log("");
  console.log(`Hoodium faucet backend`);
  console.log(`  network   : ${config.network.name} (chain ID ${chainId})`);
  console.log(`  rpc       : ${config.rpcUrl}`);
  console.log(`  vault     : ${config.vaultAddress}`);
  console.log(`  dispenser : ${vault.dispenserAddress}`);
  console.log(`  role      : ${authorised ? "authorised" : "NOT AUTHORISED"}`);
  console.log(`  paused    : ${paused}`);
  console.log(`  gas       : ${gas.toString()} wei`);
  console.log(`  captcha   : ${config.captcha.provider}`);
  console.log("");

  if (!authorised) {
    console.error(
      "[preflight] The dispenser address does not hold DISPENSER_ROLE.\n" +
        "           Claims will fail until you grant it:\n" +
        `           cd contracts && FAUCET_DISPENSER_ADDRESS=${vault.dispenserAddress} npm run grant-dispenser:devnet`,
    );
    process.exit(1);
  }

  if (gas === 0n) {
    console.error(
      "[preflight] The dispenser has no RUNE for gas. Fund it before serving claims.",
    );
  }

  const server = app.listen(config.port, () => {
    console.log(`Listening on http://0.0.0.0:${config.port}`);
  });

  // Graceful shutdown: stop accepting connections, then release Redis and RPC.
  const close = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received, shutting down...`);
    server.close(() => undefined);
    await shutdown();
    process.exit(0);
  };

  process.on("SIGTERM", () => void close("SIGTERM"));
  process.on("SIGINT", () => void close("SIGINT"));
}

main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
