# Polymarket V2 deposit-wallet — build spec (#9)

**Status:** PM order placement is the one money path not yet live. This is the
authoritative spec to unblock it. Researched 2026-06-16 against the installed
`@polymarket/clob-client-v2` + `@polymarket/builder-relayer-client` source,
verified Polygonscan contracts, `docs.polymarket.com`, and the production-proven
flow in the sibling PolyNews app (`src/hooks/use-polymarket-trade.ts`,
`use-deposit-wallet.ts`, `lib/deposit-wallet.ts`, `use-active-wallet.ts`).

## The blocker
The current adapter signs as a **bare EOA** (`signatureType=0`, `maker==signer==EOA`).
Polymarket V2's CLOB requires **new** keys to trade from a per-user **deposit
wallet** (an ERC-1967 proxy). A bare-EOA order is unsupported and gets rejected
(`not enough balance/allowance` / `invalid signature`) — which is exactly what the
prior PM attempt hit. The fix is the deposit-wallet path, not more EOA approvals.

## Decision: hand-roll, locked to an SDK-generated vector
The MCP keeps a **tiny, audited prod dependency tree** (it holds private keys — every
added dep is attack surface). So we do NOT add the Polymarket SDK to runtime deps.
Instead, mirroring how HL + PM order signing is already locked to official vectors:

- Implement the deposit-wallet **address derivation** and the **ERC-7739 order
  signature** by hand (viem + @noble only).
- Add `@polymarket/clob-client-v2` + `@polymarket/builder-relayer-client` as
  **devDependencies** only, used by a test to generate a known-good vector.
- A vector test asserts our output is **byte-identical** to the SDK's for a fixed
  order — correct by construction, and it catches drift if Polymarket changes.

## Spec

### signatureType enum (V2, on-chain `uint8`)
`EOA=0`, `POLY_PROXY=1`, `POLY_GNOSIS_SAFE=2`, **`POLY_1271=3`** (deposit wallet, new).

### Order fields for a deposit-wallet order
- `signatureType = 3` (POLY_1271)
- `maker == signer == depositWalletAddress` (both fields the deposit wallet, NOT the EOA)
- Struct + domain identical to the EOA path otherwise: `Order(uint256 salt,address
  maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8
  side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)`;
  domain `name="Polymarket CTF Exchange"` (or Neg Risk), `version="2"`, `chainId=137`,
  `verifyingContract` = CTF Exchange V2 `0xE111180000d2663C0091e4f400237545B87B996B`
  (binary) / NegRisk `0xe2222d279d744050d28e00520010520000310F59`.

### The ERC-7739 wrapped signature (the byte-exact part — lock to a vector)
For `signatureType=3` the EOA signs a **nested `TypedDataSign`** (ERC-7739 defensive):
1. `contentsHash = keccak256(abi.encode(ORDER_TYPE_HASH, ...11 order fields...))`.
2. EOA signs typed-data:
   - types: `TypedDataSign(Order contents,string name,string version,uint256
     chainId,address verifyingContract,bytes32 salt)` + the full `Order(...)` type.
   - nested-sign domain: the EXCHANGE's domain (`"Polymarket CTF Exchange"`, `"2"`,
     137, `verifyingContract = exchange`).
   - value: `contents=<order>`, `name="DepositWallet"`, `version="1"`,
     `chainId=137`, `verifyingContract = depositWalletAddress` (== maker),
     `salt=bytes32(0)`.
3. On-wire sig = `innerSig(65) ++ appDomainSep(32) ++ contentsHash(32) ++
   bytes(ORDER_TYPE_STRING) ++ uint16(len(ORDER_TYPE_STRING))`, where `appDomainSep
   = keccak256(abi.encode(DOMAIN_TYPE_HASH, nameHash("Polymarket CTF Exchange"),
   versionHash("2"), 137, exchange))`.

### Address derivation — MONEY-LOSS FOOTGUN (UUPS vs Beacon)
The deposit wallet is a Solady `LibClone` minimal proxy. `walletId = bytes32(owner)`;
`salt = keccak256(abi.encode(factory, walletId))`; address = `CREATE2(factory, salt,
initCodeHash)`. Two variants:
- **UUPS**: `initCodeHashERC1967(implementation, args)`.
- **BeaconProxy**: `initCodeHashERC1967BeaconProxy(beacon, args)`.

The installed SDK 0.0.9 derives **UUPS-only**; the live factory may use a **beacon**.
Resolve at RUNTIME exactly like SDK 0.0.10's `RelayClient.deriveDepositWalletAddress()`:
1. call factory `beacon()` (selector `0x49493a4d`); revert/zero → UUPS.
2. else if a UUPS wallet already has on-chain bytecode (legacy) → return it.
3. else → Beacon derivation.
**Always verify**: after deploy, read on-chain `getCode` at the derived address and
assert it's non-empty before funding/signing.

### Addresses (Polygon 137)
- DepositWalletFactory `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07`
- DepositWallet impl (UUPS) `0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB`
- DepositWallet beacon `0x7A18EDfe055488A3128f01F563e5B479D92ffc3a`
- pUSD collateral `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`
- Deposit-wallet EIP-712 domain: name `"DepositWallet"`, version `"1"`.
(All to be re-verified on Polygonscan when the module is written, per repo policy.)

### Deploy + register + creds
- Deploy is **gasless** via the relayer (`deployDepositWallet()`, builder HMAC; no
  user signature). Poll `getDeployed(addr, TransactionType.WALLET)` — registry lag
  ~5-10s; keep a short retry (submit-time validation lags `getDeployed`).
- Fund the deposit wallet with **pUSD** (not USDC.e). Approvals = one gasless WALLET
  batch (pUSD→3 spenders + CTF setApprovalForAll→3), signed once by the EOA.
- API creds: `createOrDeriveApiKey()` (L1 `ClobAuth` EIP-712 by the EOA) → L2 HMAC
  per order. Key is bound to the **EOA**; the order's maker/signer are the wallet.

## Build sequence (each its own commit, tested before live)
1. `polymarket-deposit-wallet.ts`: constants (re-verified) + address derivation
   (UUPS + Beacon + runtime `beacon()` check). Unit-test the CREATE2 math; lock to
   a vector from PolyNews `lib/deposit-wallet.ts` (ground truth in the user's tree).
2. ERC-7739 order signing for `signatureType=3`. **Lock to a vector** generated from
   `clob-client-v2` (devDep). This is the byte-exact, must-not-rush step.
3. Relayer client: gasless deploy + `getDeployed` poll (registry-lag retry) + the
   approval batch. Adapter branches EOA(0) vs deposit-wallet(3) on a config flag.
4. Live-verify the MUST-VERIFY checklist with a 1-share order before trusting it.

## MUST-VERIFY-LIVE (before real funds)
1. **UUPS vs Beacon** — call factory `beacon()`; confirm the derived address matches
   on-chain `getCode` after deploy. (Highest stakes — wrong address = lost funds.)
2. **POLY_1271 signature** — place a 1-share GTC BUY; confirm no invalid-signature
   rejection (validates the whole ERC-7739 wrap against the live ERC-1271 validator).
3. **`POLY_ADDRESS` in L2 headers** for a type-3 order — EOA or deposit wallet?
4. **CLOB balance-cache** association (`signature_type=3`) — explicit API call or
   server-side off the approval batch? Order fails on a balance error if not cached.
5. **NegRisk domain name** string — only before trading multi-outcome markets.
6. **Relayer deadline floor** — docs say 240s; PolyNews found ~30min required.

## Sources
clob-client-v2 + builder-relayer-client source (signatureType enum, createOrder,
buildOrderSignature, derive.js); Polygonscan verified contracts; docs.polymarket.com
(v2-migration, trading/deposit-wallets); PolyNews app hooks (production-proven).
