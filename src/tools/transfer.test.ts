// src/tools/transfer.test.ts
// The auto-rail decision (pickRail) + the CCTP flightId route round-trip
// (cctpFlightRoute, which advance_bridge uses to mint) — both pure, so vector-
// tested here. The full source-execute + mint-drive path signs + broadcasts real
// burns and is proven LIVE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickRail, destGasFloor } from "./transfer.js";
import { flightIdForRoute, bindBurnHash, cctpFlightRoute } from "../bridge/cctp.js";
import type { BridgeRoute } from "../bridge/types.js";

test("pickRail: both-EVM + dest holds mint-gas -> CCTP", () => {
  assert.equal(pickRail({ fromChain: "polygon", toChain: "hyperliquid", destNativeGas: 0.01 }).rail, "cctp");
});

test("pickRail: both-EVM but dest gas below floor -> deBridge (solver delivers)", () => {
  const r = pickRail({ fromChain: "hyperliquid", toChain: "polygon", destNativeGas: 0 });
  assert.equal(r.rail, "debridge");
  assert.match(r.reason, /deBridge|no dest gas/);
});

test("pickRail: any Solana leg -> deBridge regardless of gas", () => {
  assert.equal(pickRail({ fromChain: "solana", toChain: "polygon", destNativeGas: 999 }).rail, "debridge");
  assert.equal(pickRail({ fromChain: "polygon", toChain: "solana", destNativeGas: 999 }).rail, "debridge");
});

test("pickRail: an explicit provider override always wins", () => {
  assert.equal(pickRail({ fromChain: "polygon", toChain: "hyperliquid", destNativeGas: 999, override: "debridge" }).rail, "debridge");
  assert.equal(pickRail({ fromChain: "polygon", toChain: "hyperliquid", destNativeGas: 0, override: "cctp" }).rail, "cctp");
});

test("destGasFloor: Polygon needs more native gas than Arbitrum", () => {
  assert.ok(destGasFloor("polygon") > destGasFloor("hyperliquid"));
});

test("cctpFlightRoute round-trips the route encoded in a CCTP flightId", () => {
  const route: BridgeRoute = {
    fromChain: "polygon",
    toChain: "hyperliquid",
    token: "USDC",
    amount: "1.5",
    recipient: "0x1111111111111111111111111111111111111111",
  };
  const id = bindBurnHash(flightIdForRoute(route, "0"), "0x" + "ab".repeat(32));
  const back = cctpFlightRoute(id);
  assert.equal(back.toChain, "hyperliquid"); // load-bearing for recover()
  assert.equal(back.fromChain, "polygon");
  assert.equal(back.amount, "1.5");
  assert.equal(back.recipient.toLowerCase(), route.recipient.toLowerCase());
});
