# Solana Program Deploy — Debugging Log (for a Solana AI Kit skill)

A real, ordered log of every error hit while taking a Solana program from code to a devnet
deploy, the root cause, and the fix. Includes the AI assistant's own wrong turns and corrections.
Use this to build a "deploy a Solana program, unblock the common failures" skill.

## The one mental model that explains most of it
There are **three toolchain zones**, and you must land in the middle:
- **Too old** (e.g. Solana SBF Rust 1.75): fails to compile modern build deps → `edition2024 required`.
- **Too new** (e.g. Solana Playground's bleeding-edge toolchain): compiles to an sBPF VM version the
  cluster hasn't enabled → `sbpf_version ... not enabled` at deploy.
- **Just right** (e.g. **Solana 1.18.26** + a **native** program): compiles cleanly *and* emits
  sBPFv1, which devnet runs.
Pin the toolchain; don't use "latest" blindly.

---

## Errors, causes, fixes (in the order they happened)

### 1. `cd /workspaces/<repo>` → No such file or directory
- **Cause:** assumed the repo folder name; the repo had been renamed (agent-rewards → KZP-circle).
- **Fix:** `ls /workspaces` and `cd` into the actual folder. Codespace terminals often already open in it.

### 2. `lock file version 4 requires -Znext-lockfile-bump`
- **Cause:** the system Cargo wrote `Cargo.lock` in **v4** format, but `cargo-build-sbf`'s bundled
  Cargo (Rust 1.75) only parses **v3**.
- **Fix (one-off):** pin the lock header down: `sed -i 's/^version = 4/version = 3/' Cargo.lock`
  (v3/v4 carry identical data; only the header differs).
- **Why `rm Cargo.lock` doesn't help / durable fix:** `cargo build-sbf` runs `cargo metadata` with
  the **system** Cargo, and Cargo **≥ 1.83 defaults to lockfile v4**, so it regenerates v4 every
  build. Make the system toolchain write v3 instead:
  ```bash
  rustup toolchain install 1.79.0 && rustup default 1.79.0   # v4 became default in Rust 1.83
  ```
  (The SBF *compile* still uses platform-tools Rust 1.75; the system toolchain only does resolution.)

### 3. `feature edition2024 is required` (e.g. `toml_datetime 1.1.1`)
- **Cause:** a fresh resolve pulled newer *build-time* crates needing Rust 1.85; the SBF Rust is 1.75.
- **Fix (Anchor builds):** pin them back:
  ```bash
  cargo update -p toml_edit --precise 0.22.22
  cargo update -p toml_datetime --precise 0.6.8
  ```
  Cargo surfaces these one at a time; pin each it names. **A native program (`solana-program` +
  `borsh` + `spl-token`) avoids this entirely** — it never pulls the toml tooling.

### 4. Deploy cost quoted at ~6.8 SOL (only had ~2)
- **Cause:** Anchor's binary floor (~250–450 KB no matter how little code) **×2** because upgradeable
  deploys reserve double the size for future upgrades.
- **Fixes:** (a) size-opt the build — `[profile.release] opt-level="z", lto="fat", strip=true`;
  (b) deploy **non-upgradeable** — `solana program deploy --final <so>` (halves it);
  (c) **go native** (~80–130 KB) — the only reliable way to fit ~2 SOL.

### 5. Playground "Connection error / change RPC"; then "N transactions not confirmed, retrying"
- **Cause:** a program deploy is `ceil(size / ~1KB)` separate txns; the free public
  `api.devnet.solana.com` rate-limits after a few dozen, so chunks never confirm.
- **Fix:** use a dedicated RPC (free Helius/QuickNode devnet key). The deploy **resumes from the
  buffer** on retry — you don't pay twice. Falling "not confirmed" count = it's working.

### 6. `...?api-key=KEY/build` → `Method not found`
- **Cause:** a path got appended after the query string, corrupting the RPC URL.
- **Fix:** the endpoint must be exactly `https://devnet.helius-rpc.com/?api-key=KEY` — no trailing
  path or slash.

### 7. `Detected sbpf_version required by the executable which are not enabled`
- **Cause:** Playground's toolchain compiled to a newer sBPF VM version than devnet enables.
- **Fix:** build with an **older, pinned** toolchain — install **Solana 1.18.26**
  (`sh -c "$(curl -sSfL https://release.anza.xyz/v1.18.26/install)"`) so `cargo-build-sbf` emits sBPFv1.

### 8. `current package believes it's in a workspace when it's not`
- **Cause:** a standalone crate living inside a repo that already has a root workspace `Cargo.toml`.
- **Fix:** add an empty `[workspace]` table to the crate's own `Cargo.toml` so it stands alone.

### 9. `No default signer found`
- **Cause:** a fresh Codespace has no wallet at `~/.config/solana/id.json`.
- **Fix:** import the funded keypair (from a base58 secret) — never paste the key into a chat:
  ```bash
  npm i bs58
  node -e "const b=require('bs58').default||require('bs58');const fs=require('fs');fs.writeFileSync(process.env.HOME+'/.config/solana/id.json',JSON.stringify(Array.from(b.decode(process.argv[1]))))" "PASTE_BASE58_SECRET"
  solana address   # verify it matches the funded wallet
  ```

### 10. Vercel: deploys ERROR (git) / BLOCKED (CLI), site shows 401 / "Security Checkpoint"
- **Causes & fixes (bonus, same project):** app in a subfolder → set Vercel **Root Directory**;
  too many rapid CLI deploys → Hobby allows 1 concurrent build, deploy via **git push** instead;
  **Deployment Protection** on → 401 for the public (disable via dashboard or
  `PATCH /v9/projects/{id}` `{"ssoProtection":null}`); 403 "Security Checkpoint" = bot challenge,
  real browsers pass.

---

## The assistant's own mistakes (own them in the skill)
- **Under-estimated deploy cost** (~2.5 SOL) when Anchor + 2× reservation made it 6.8. Lesson: always
  compute `solana rent $(stat -c%s <so>)` and remember upgradeable = 2× size.
- **Gave `anchor build`/`anchor deploy` for a *native* program.** Native uses `cargo build-sbf` +
  `solana program deploy`. Don't conflate the two toolchains.
- **Assumed the Codespace path** instead of discovering it (`ls /workspaces`).
- **Didn't pin the toolchain up front**, so we ping-ponged between "too old" (edition2024) and
  "too new" (sbpf) before landing on native + Solana 1.18.26.

## Minimal known-good recipe (native, devnet)
```bash
# Solana 1.18.26 (sBPFv1)
sh -c "$(curl -sSfL https://release.anza.xyz/v1.18.26/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
# standalone native crate: [workspace] empty table in its Cargo.toml; deps solana-program 1.18 / borsh 0.10 / spl-token 4
cd <crate>
sed -i 's/^version = 4/version = 3/' Cargo.lock 2>/dev/null || true
cargo build-sbf
# wallet + dedicated RPC
solana config set --url "https://<dedicated-devnet-rpc>"
solana program deploy target/deploy/<name>.so
```
