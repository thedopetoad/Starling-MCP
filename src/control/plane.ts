// src/control/plane.ts
// The MCP side of the dashboard control plane. The Starling dashboard can't share
// this server's stdio pipe (that belongs to the agent that launched us), so we
// coordinate through small files under ~/.starling/ — the same shared-file idea as
// treasury.json. See the dashboard repo's CONTROL_PROTOCOL.md for the full wire
// contract.
//
//   here -> dashboard :  status.json     (heartbeat we publish on a timer)
//   dashboard -> here :  trading.halt    (kill-switch FLAG; presence == halt)
//   dashboard -> here :  control/<id>.cmd.json   (an action to run)
//   here -> dashboard :  control/<id>.ack.json   (the result)
//
// This module is pure file I/O + classification. It NEVER signs or moves funds: the
// halt gate is enforced by the caller (server.ts) refusing trade-entry tools while
// the flag exists; the command drain currently only toggles the halt flag and acks
// the money-moving actions honestly (they land after testnet validation).
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile, rename, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { starlingDir } from "../keystore/store.js";
import type { CommandRunner } from "./commands.js";

const log = (m: string) => process.stderr.write(`[starling] ${m}\n`);
const now = () => new Date().toISOString();

export function statusPath(): string {
  return join(starlingDir(), "status.json");
}
export function haltPath(): string {
  return join(starlingDir(), "trading.halt");
}
export function controlDir(): string {
  return join(starlingDir(), "control");
}

// ── halt flag (the kill switch) ───────────────────────────────────────────────
/** Does the dashboard's kill-switch flag exist right now? Sync + cheap — called on
 *  the request hot path before any trade-entry tool runs. */
export function haltActive(): boolean {
  return existsSync(haltPath());
}
/** Best-effort read of the flag's reason (for logs / status). Never throws. */
export function haltInfo(): { reason?: string } | null {
  try {
    return JSON.parse(readFileSync(haltPath(), "utf8"));
  } catch {
    return haltActive() ? { reason: "manual" } : null;
  }
}
async function setHalt(reason: string): Promise<void> {
  await writeJsonAtomic(haltPath(), { version: 1, reason, source: "mcp", ts: now() });
}
async function clearHalt(): Promise<void> {
  await rm(haltPath(), { force: true });
}

// ── which tools the halt flag blocks ──────────────────────────────────────────
// The kill switch stops the agent OPENING/INCREASING exposure. It must NOT block
// risk-reducing or fund-homing ops, so the dashboard (and the user) can still close
// positions, cancel orders, and withdraw to the pinned treasury while halted.
// Allowed while halted: all reads, close_position, *_cancel/_exit/_claim,
// *_withdraw, build_withdraw, pm_withdraw, hl_bridge_out, transfer, advance_bridge,
// ensure_gas, enable_venue, hl margin/leverage/usd-class moves, delegate, and the
// WITHDRAW side of vault/stake. ALSO blocked (beyond this set): the DEPOSIT side of
// hl_vault_transfer / hl_stake — see HALT_BLOCKED_ON_DEPOSIT below (they lock funds).
export const HALT_BLOCKED_TOOLS: ReadonlySet<string> = new Set<string>([
  "open_position",
  "hl_order",
  "hl_twap",
  "jup_pred_buy",
  "jup_limit_create",
  "jup_recurring_create",
  "jup_lend_deposit",
  "jup_lend_borrow",
]);

// Capital-deploying tools whose DEPOSIT direction LOCKS funds for days (HLP ~4-day
// lockup; staking ~7-day unbond), so a halt must block the deposit side too — else a
// rogue/buggy agent could lock funds during the very halt meant to get you flat. The
// WITHDRAW/unstake side stays ALLOWED (you must always be able to exit). These tools
// carry a direction arg, so the check is arg-aware (name-only halting can't tell which).
const HALT_BLOCKED_ON_DEPOSIT: ReadonlyArray<{ tool: string; isDeposit: (a: Record<string, unknown>) => boolean }> = [
  { tool: "hl_vault_transfer", isDeposit: (a) => a.isDeposit === true },
  { tool: "hl_stake", isDeposit: (a) => a.direction === "deposit" },
];

/** PURE classification (no I/O): would a halt block this tool + args? Exported for tests. */
export function haltBlocks(tool: string, args?: Record<string, unknown>): boolean {
  if (HALT_BLOCKED_TOOLS.has(tool)) return true;
  const dep = HALT_BLOCKED_ON_DEPOSIT.find((d) => d.tool === tool);
  return dep ? dep.isDeposit(args ?? {}) : false;
}

/** True if `tool` should be refused right now because trading is halted. Arg-aware:
 *  blocks trade entry + the DEPOSIT side of vault/stake; allows the withdraw/exit side. */
export function isHaltBlocked(tool: string, args?: Record<string, unknown>): boolean {
  return haltActive() && haltBlocks(tool, args);
}

// ── status heartbeat (here -> dashboard) ──────────────────────────────────────
/** Atomically publish the snapshot the dashboard renders. Caller builds the object
 *  (server.ts owns the state sources); we just write it safely. */
export async function writeStatus(snapshot: unknown): Promise<void> {
  await writeJsonAtomic(statusPath(), snapshot);
}

// ── command drain (dashboard -> here -> dashboard) ────────────────────────────
/** Process any new dashboard commands and write their acks. Idempotent: a command
 *  with an existing ack is skipped. Safe to call on every heartbeat tick.
 *  halt/resume are handled here (just flag the kill-switch); the money actions
 *  (close_all / withdraw / consolidate) are delegated to `run` when provided —
 *  server.ts injects a runner bound to the real deps + the dry-run/execute gate. */
export async function drainControl(run?: CommandRunner): Promise<void> {
  const dir = controlDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // no control dir yet — nothing to do
  }
  for (const f of entries) {
    if (!f.endsWith(".cmd.json")) continue;
    const id = f.slice(0, -".cmd.json".length);
    const ackPath = join(dir, `${id}.ack.json`);
    if (existsSync(ackPath)) continue; // already handled — idempotent by id
    let cmd: { action?: string; args?: Record<string, unknown> };
    try {
      cmd = JSON.parse(await readFile(join(dir, f), "utf8"));
    } catch {
      continue; // partial/corrupt write — try again next tick
    }
    const action = cmd?.action;
    let ack: Record<string, unknown>;
    if (action === "halt") {
      await setHalt(String(cmd?.args?.reason ?? "dashboard"));
      ack = { id, action, status: "ok", message: "trading halted", ts: now() };
    } else if (action === "resume") {
      await clearHalt();
      ack = { id, action, status: "ok", message: "trading resumed", ts: now() };
    } else if (
      action === "close_all" ||
      action === "withdraw" ||
      action === "murmur_nav" ||
      action === "murmur_deploy" ||
      action === "murmur_close"
    ) {
      if (!run) {
        ack = {
          id, action, status: "error", code: "no_runner",
          message: `${action} can't run: no command runner wired (the MCP didn't start with deps).`,
          ts: now(),
        };
      } else {
        const r = await run(action, (cmd?.args as Record<string, unknown>) ?? {});
        ack = { id, action, ...r, ts: now() };
      }
    } else {
      ack = { id, action: action ?? null, status: "error", message: `unknown action ${String(action)}`, ts: now() };
    }
    try {
      await writeJsonAtomic(ackPath, ack);
      log(`control: ${action} (${id}) -> ${ack.status}`);
    } catch (e) {
      log(`control: failed to ack ${id}: ${(e as Error).message}`);
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────
async function writeJsonAtomic(dest: string, payload: unknown): Promise<void> {
  // Ensure the destination's directory exists (control/ for acks, ~/.starling for the rest).
  await mkdir(dest.startsWith(controlDir()) ? controlDir() : starlingDir(), { recursive: true });
  const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await rename(tmp, dest); // atomic on the same filesystem — readers never see a partial file
}
