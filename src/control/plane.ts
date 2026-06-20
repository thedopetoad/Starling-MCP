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
// ensure_gas, enable_venue, hl margin/leverage/vault/usd-class moves, stake/delegate.
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

/** True if `tool` should be refused right now because trading is halted. */
export function isHaltBlocked(tool: string): boolean {
  return haltActive() && HALT_BLOCKED_TOOLS.has(tool);
}

// ── status heartbeat (here -> dashboard) ──────────────────────────────────────
/** Atomically publish the snapshot the dashboard renders. Caller builds the object
 *  (server.ts owns the state sources); we just write it safely. */
export async function writeStatus(snapshot: unknown): Promise<void> {
  await writeJsonAtomic(statusPath(), snapshot);
}

// ── command drain (dashboard -> here -> dashboard) ────────────────────────────
/** Process any new dashboard commands and write their acks. Idempotent: a command
 *  with an existing ack is skipped. Safe to call on every heartbeat tick. */
export async function drainControl(): Promise<void> {
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
    } else if (action === "close_all" || action === "withdraw") {
      // Honest placeholder: these move real money through execution paths that
      // still need testnet validation, so we don't auto-run them from a file yet.
      ack = {
        id,
        action,
        status: "error",
        code: "unsupported_on_this_build",
        message:
          `${action} from the dashboard isn't enabled on this MCP build yet. ` +
          `Halt works now; ${action} lands after the execution paths are validated on testnet.`,
        ts: now(),
      };
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
