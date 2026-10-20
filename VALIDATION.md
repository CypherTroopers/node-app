# Standalone application validation — 2026-10-20

Scope: the standalone application originally developed at `work/cypher-node-app`, prepared for the independent `CypherTroopers/node-app` repository. The preserved plugin, its remote `plugin` branch, original CypherClaw, operator state, and live nodes were not modified. No application release was published during validation. Referenced artifacts are local validation evidence and are excluded from normal source commits.

## Build and tests

- Dedicated, frozen pnpm installation; no OpenClaw runtime or development dependency.
- All backend/desktop/browser builds and TypeScript checks passed.
- **178 tests in 16 files passed** before the final ASAR copy repair: Vitest 5.22 seconds, wall time 5.98 seconds on this host. Tests use isolated state, loopback listeners, and owned local subprocess fixtures.
- After that focused repair, all **18 installer/downloader tests passed** again: Vitest 1.49 seconds, wall time 2.11 seconds. The final source also passed build, full TypeScript, formatting, and whitespace checks. Actual packaged setup/restart is the regression proof for the Electron-specific failure.
- Coverage includes native pins/download integrity, the six-tab UI, transaction durability/authority/finality, revocable local sessions, literal Host/Origin admission, duplicate-state ownership, process output limits/minimal environment/cancellation, and graceful shutdown/retry.
- A browser regression reproduced reused-tab bootstrap URLs failing to authenticate; hash changes now scrub the token and admit the new session correctly.
- A real HTTP lifecycle regression reproduced startup continuing after Close. Shutdown now retires admission, joins startup, and retains the state lock until cleanup completes.
- An initial Host test used Fetch, which derives that header from its URL. Literal HTTP was used to prove the actual server boundary; the product Host guard was already correct.

The initial local validation dispatched no CI. Hosted platform evidence from the later Actions work is recorded separately below; local ConPTY lifecycle fixtures alone are not Windows device evidence.

## Actions native refresh and repository independence

The integrated Actions/export change passed all **187 tests in 17 files** with one worker: Vitest 14.96 seconds, wall time 15.74 seconds. Build, full TypeScript, and changed-file formatting also passed.

`Node App Build` is a manual workflow: one Linux seed resolves the requested `FHS-D` ref exactly once, validates upstream native provenance and bytes, generates node pins, and shares one hashed source snapshot with Windows x64, macOS ARM64, and Linux x64 packaging jobs. The workflow has no schedule, automatic source commits, or Release publication, and keeps only read access to repository contents. Native node executables remain separate downloads performed by the application's explicit Prepare operation.

The sync CLI was exercised against the actual public upstream repository. It resolved `FHS-D` to `9ca4b9793d6e3527f4439ab4cc29a500a160c134`, streamed and verified all **17 node artifacts** across the three OS targets, and generated the shared pins without saving native payloads. Metadata matches the previous fixed baseline; the wallet generator is unchanged. Receipt: `artifacts/validation/native-sync.json`.

All **nine sync CLI contract tests passed**, including fixed-commit requests, dynamically discovered Windows DLLs, malformed or incomplete producer records, mismatched bytes/digests, mixed source builds, incompatible declared IPC finality, stale native builds, and generation drift. Runner time was 1.91 seconds, wall time 2.63 seconds. The first default-sandbox attempt lost child stdout/stderr; an independent Node pipe probe established that host tooling limitation, and unchanged assertions passed under the supported subprocess execution environment.

The initial workflow passed actionlint 1.7.12, YAML/format validation, and syntax parsing of its Bash steps and embedded JavaScript programs. Static checks alone do not establish native installer acceptance; later hosted results and Windows recovery are recorded below.

Standalone repository metadata and documentation now use `CypherTroopers/node-app`. The browser proof no longer requires sibling plugin files: it checks the retained artwork against both a fixed digest and its own canonical asset, and includes a comparison image only when an explicit optional baseline is supplied. Original before/after evidence remains retained separately.

The repaired proof ran once from an isolated source/build copy with no sibling plugin and no baseline argument: **nine check groups passed, zero page errors**, fixed artwork digest matched, and actual HTTP login/logout plus synthetic node-management flows completed. The report, gallery, and copy provenance are retained under `artifacts/proof/isolated-export-sz6s3u_e`; all owned temporary state, server, and browser processes were removed.

The complete Actions/export diff received fresh canonical independent review and returned `scoped-clean` at P0/P1. Results are retained in `artifacts/validation/actions-review.txt` and `actions-review-status.json`. These local results do not establish hosted Windows/macOS acceptance.

Canonical autoreview assessed the complete frozen source in two passes and returned `scoped-clean` at P0/P1. This is a scoped independent assessment, not a claim of no remaining lower-priority defects. Results are in `artifacts/validation/review.txt` and `review-status.json`. A behavior-neutral cleanup pass found no additional source changes to make.

The later ASAR repair received a fresh, focused canonical review with the complete installer and relevant unchanged contracts supplied. It also returned `scoped-clean` at P0/P1; see `artifacts/validation/asar-review.txt` and `asar-review-status.json`.

## Hosted Actions and Windows recovery

The independent public repository is `CypherTroopers/node-app`. Manual Actions runs exercised upstream resolution, provenance verification, frozen dependency installation, full source checks, native Electron/SQLite runtime checks, and packaging. Linux x64 and macOS ARM64 installers were produced successfully. These are hosted build results, not physical desktop acceptance or signing/notarization evidence.

Windows first exposed two workflow invocation defects: a job-level working-directory default shadowed the global Bash shell, and multiline JavaScript passed through a Windows `.cmd` shim was rejected. The workflow now declares Bash on the build job and runs the runtime proof through a real script file.

[Diagnostic run 39419454453](https://github.com/CypherTroopers/node-app/actions/runs/39419454453), at app commit `34838b6b2c8c2d3600b411bec9ee432b56bbbf63`, established a separate native runtime defect: ConPTY returned output and a genuine exit code 0, but the host remained alive until the two-minute step deadline. The exact pinned dependency retains referenced workers after natural terminal exit. Calling its cached-PID kill path after exit could target a reused PID and is not used as cleanup. The observed initial PID was also 0 until the asynchronous connection completed.

Windows terminal handling is now isolated in an app-owned helper process. The manager retains ownership until genuine launcher exit, IPC absence, and helper closure have all completed. Helper failure does not impersonate launcher exit; failed shutdown/release keeps the owner for retry. Startup cancellation can terminate only an uncommitted helper that has received no launch command. Accepted launch/stop cleanup survives browser disconnection.

The hosted runtime proof uses the actual production adapter with a controlled PowerShell script, verifies output, a positive live PID, actual terminal exit, helper retirement, and natural parent exit. A second invocation uses the packaged Windows executable and its unpacked helper/dependencies to cover ASAR resolution. It starts no Cypher chain or mining. Final hosted results for this repair are recorded after validation.

Before the repair, two new manager regression cases failed in an isolated snapshot for the intended reasons: Close incorrectly succeeded despite failed host release, and a failed control host remained in `starting`. The snapshot reused the frozen dependency installation; pnpm's automatic dependency verification could not recreate a symlinked module directory, but Vitest itself executed both assertions and reported those product-boundary failures. Later checks invoke the installed tools directly rather than reconciling a shared installation.

## Actual desktop application

Electron **44.9.1**, embedded Node **24.22.0**, and built-in SQLite were exercised on Linux. A real PTY child also completed under Electron, verifying the installed Linux native dependency against the embedded runtime.

The pre-Actions Linux AppImage was built and launched directly. Eight actual desktop checks passed: cold startup with six tabs/logo and no automatic native download/start, renderer isolation, real preparation through the Node tab, all five native download hashes/sizes, all 33 bundled static files copied byte-for-byte, the packaged SQLite worker (synthetic write/read), blocked unsafe navigation, and clean shutdown followed by warm restart admitting the existing cache without rewriting native files. Evidence and the inspected ready-state screenshot are under `artifacts/proof/desktop-prepare-ejrIj6`. Earlier proofs remain retained and are superseded for that artifact.

The first packaged setup attempt exposed an Electron-specific failure: recursive `fs.cp` could not read the bundled ASAR license directory, although the same directory was present and readable with `readdir`. The installer now copies through archive-aware reads and exclusive stage writes, preserving current authority, private permissions, and atomic activation. The original failure and direct filesystem diagnosis are retained under `artifacts/proof/desktop-prepare-ZmhamN` and `artifacts/proof/asar-copy-fS5p8d`; the final real Prepare operation returned HTTP 200 and `ready`.

Previously verified desktop artifact: `release/ColossusX-Node-Manager-0.1.0-linux-x86_64.AppImage`, **125,707,561 bytes** (about 120 MiB). SHA-256: `c54ad145c60c72bcd8744617689a2e345d5ce3757beb5c083221611840636a6d`. Its receipt binds the artifact and source/build hashes before the Actions/export change. Owned proof processes, profiles, temporary scripts, and the 58 MB native cache were cleaned after both launches.

This container's root user required `--no-sandbox` in the QA launcher only, and the official AppImage extract-and-run mode avoided a FUSE dependency. Production does not set those flags. Renderer preferences are `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and `webSecurity: true`; OS sandbox enforcement was not proven under this root-host QA configuration.

The desktop bundle contains Electron/Chromium and native PTY components, so it is larger than the former plugin. Cypher node programs, wallet executables, and node-specific Windows DLLs are fetched separately.

## Actual native setup and execution

Through the standalone application's authenticated HTTP API, explicit setup fetched the Linux target's five files (**58,238,627 bytes**) from immutable public repository commits. Each installed byte length and SHA-256 was independently verified. Cold startup created no native runtime and started no node.

The independent wallet generator successfully ran through the new local process owner in 96 ms. The proof recorded only address/private-key validity booleans; returned values were not printed or persisted. The verified node's `version` command exited 0 in 106 ms with version **1.9.20-stable** and source commit `546d43442e8156591786dc3c1ca1596f014509e3`.

The whole native proof took 5.47 seconds. Its app, synthetic state, and 58 MB downloads were removed. Receipt: `artifacts/validation/native-runtime.json`. This HTTP/process proof preceded the ASAR-only copy repair; final packaged setup and cache admission were separately verified above. Chain startup/synchronization, mining, IPC node operation, and funded transfers were not performed against the real network.

## Browser evidence

Playwright exercised the real standalone HTTP authentication/session and cold UI, plus explicitly labeled synthetic RPCs for connected-node states. **Nine check groups passed**, no page errors: all six tabs, original artwork, private-key masking/clearing, transfer review/confirmation/finality, separate signer/reward, Explorer, 390-pixel mobile layout, Japanese preparation failure/retry, and local feedback persistence/export.

Before/after screenshots and the inspected gallery are in `artifacts/proof/standalone-cpfFCa`. Simulated wallet/chain state is not a claim of real funds or network execution. The owned server was stopped and temporary state removed.

## Platform and distribution limits

Supported targets are Windows x64 portable EXE, macOS ARM64 DMG, and Linux x64 AppImage. Hosted build results are recorded above; physical Windows/macOS desktop behavior was not exercised on this Linux host. The packaging guard requires each matching native host and its platform PTY package. macOS Intel, Linux ARM64, and Windows ARM64 are intentionally unsupported because corresponding node artifacts are unavailable.

Signing, notarization, publication, and automatic updates were not performed. The app does not migrate another installation's chain, keystore, or transaction history. See README for independent state and shutdown behavior.
