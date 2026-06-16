// src/validate/inspect.test.ts — proves inspect-before-sign catches swapped
// recipients, smuggled approve spenders, and wrong CCTP mint recipients.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertTargetAllowed,
  assertTransferToTreasury,
  assertApproveSpenderAllowed,
  assertCctpMintRecipient,
  addressToBytes32,
  InspectError,
  encodeFunctionData,
  ERC20_ABI,
  CCTP_ABI,
} from "./inspect.js";

const TREASURY = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0x2222222222222222222222222222222222222222";
const V2_EXCHANGE = "0x3333333333333333333333333333333333333333";
const USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";

const transfer = (to: string) =>
  encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to as `0x${string}`, 1_000_000n] });
const approve = (spender: string) =>
  encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [spender as `0x${string}`, 1_000_000n] });
const depositForBurn = (mintRecipient: string) =>
  encodeFunctionData({
    abi: CCTP_ABI,
    functionName: "depositForBurn",
    args: [1_000_000n, 7, addressToBytes32(mintRecipient), USDC as `0x${string}`, addressToBytes32(TREASURY), 0n, 2000],
  });

test("assertTargetAllowed: pinned target passes, unknown throws", () => {
  assert.doesNotThrow(() => assertTargetAllowed(V2_EXCHANGE, [V2_EXCHANGE, USDC]));
  assert.throws(() => assertTargetAllowed(ATTACKER, [V2_EXCHANGE, USDC]), (e: unknown) => e instanceof InspectError && e.code === "target_not_allowed");
});

test("transfer to treasury passes; to attacker is rejected", () => {
  assert.doesNotThrow(() => assertTransferToTreasury(transfer(TREASURY), TREASURY));
  assert.throws(() => assertTransferToTreasury(transfer(ATTACKER), TREASURY), (e: unknown) => e instanceof InspectError && e.code === "recipient_not_treasury");
});

test("an approve passed to the transfer check is caught (not a transfer)", () => {
  assert.throws(() => assertTransferToTreasury(approve(V2_EXCHANGE), TREASURY), (e: unknown) => e instanceof InspectError && e.code === "not_a_transfer");
});

test("approve+transferFrom escape: spender must be allowlisted", () => {
  // legit: approve the venue exchange to pull collateral
  assert.doesNotThrow(() => assertApproveSpenderAllowed(approve(V2_EXCHANGE), [V2_EXCHANGE]));
  // attack: approve(attackerContract, MAX) — the drain a recipient-only check misses
  assert.throws(
    () => assertApproveSpenderAllowed(approve(ATTACKER), [V2_EXCHANGE]),
    (e: unknown) => e instanceof InspectError && e.code === "approve_spender_not_allowed",
  );
});

test("CCTP mintRecipient must decode to the treasury", () => {
  assert.doesNotThrow(() => assertCctpMintRecipient(depositForBurn(TREASURY), TREASURY));
  assert.throws(
    () => assertCctpMintRecipient(depositForBurn(ATTACKER), TREASURY),
    (e: unknown) => e instanceof InspectError && e.code === "mint_recipient_not_treasury",
  );
});

test("addressToBytes32 round-trips through the CCTP decoder", () => {
  // sanity: the bytes32 we build is what the decoder reads back as the address
  assert.doesNotThrow(() => assertCctpMintRecipient(depositForBurn(TREASURY), TREASURY));
});
