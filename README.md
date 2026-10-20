# ColossusX Node Manager

A local desktop application for **Windows x64, macOS Apple silicon (ARM64), and Linux x64**, preserving the CypherClaw artwork and six tabs: Overview, Node, Wallets, Send, Mining, and Explorer.

**Download the desktop app below. You do not need to clone this repository, build the source, or install Git, Node.js, or OpenClaw.** The app includes its own desktop runtime.

## Download and open the app

Sign in to GitHub, then choose the download for your computer. Each link downloads a ZIP containing the ready-to-run app and its checksum files. [GitHub requires sign-in to download these build artifacts](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts).

| Your computer                 | Download                                                                                                          | File to open after extracting the ZIP                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Windows, Intel/AMD 64-bit     | [Download Windows ZIP](https://github.com/CypherTroopers/node-app/actions/runs/39420949839/artifacts/12263693137) | `ColossusX-Node-Manager-0.1.0-win-x64.exe`           |
| Mac, Apple silicon (M-series) | [Download Mac ZIP](https://github.com/CypherTroopers/node-app/actions/runs/39420949839/artifacts/12262429443)     | `ColossusX-Node-Manager-0.1.0-mac-arm64.dmg`         |
| Linux, Intel/AMD 64-bit       | [Download Linux ZIP](https://github.com/CypherTroopers/node-app/actions/runs/39420949839/artifacts/12263134727)   | `ColossusX-Node-Manager-0.1.0-linux-x86_64.AppImage` |

These are version **0.1.0 test builds** from the [successful build run](https://github.com/CypherTroopers/node-app/actions/runs/39420949839). The downloads expire on **November 3, 2026 (UTC)**. No permanent GitHub Release download has been published. Intel Macs are not supported.

1. Download the ZIP for your computer and extract it. On Windows, right-click the ZIP and choose **Extract All**. On Mac, double-click the ZIP. On Linux, use your archive manager's **Extract** action.
2. Open the extracted app:
   - **Windows:** Double-click the `.exe`. This is a portable app; no installer wizard is required.
   - **Mac:** Open the `.dmg`, drag **ColossusX Node Manager** to **Applications**, then open it from Applications.
   - **Linux:** Allow the `.AppImage` to run as a program in its file properties, then open it. If needed, see the Linux requirements below.
3. The app opens a window with six tabs. Continue with **Prepare node** and **Start node** below.

The test builds are unsigned, and the Mac app is not notarized. Windows or macOS may block launch or display a security warning. These builds have not completed full desktop acceptance on Windows/macOS; see [validation status](VALIDATION.md#platform-and-distribution-limits).

## Use the application

1. Open **ColossusX Node Manager** using the instructions above.
2. In **Overview** or **Node**, choose **Prepare node** and wait until setup reports **Ready**. This downloads only the node executable, required Windows DLLs, and independent wallet generator needed by your computer. The app checks every file before using it. An internet connection is required for this first setup.
3. In **Node**, choose **Start node**. Preparation alone never starts a node or mining. Use **Connect IPC** for a compatible externally managed node.
4. Manage wallets, reviewed/confirmed transfers, mining signer and reward recipient, and Explorer from the existing tabs.
5. Use **Stop node**, or close the application to gracefully stop its owned node and settle downloads, wallet generation, and the transfer worker. Keep the application open while its node should run. Disconnecting an external node does not stop it.

The desktop window signs into its own loopback service automatically. Signing out revokes the local session and clears sensitive page values. Close and reopen the desktop application to sign in again.

The [preserved OpenClaw plugin](https://github.com/CypherTroopers/cypherclaw/tree/plugin/work/cypher-node-plugin) remains unchanged in the original repository.

Linux needs your distribution's Electron desktop libraries and AppImage support. Without FUSE, the AppImage runtime supports `APPIMAGE_EXTRACT_AND_RUN=1 ./ColossusX-Node-Manager-0.1.0-linux-x86_64.AppImage`. Production does not disable Electron's sandbox; run as a normal desktop user.

## Data and authentication

Native programs live outside the read-only application bundle. Desktop state is under Electron's OS-specific `ColossusX Node Manager` user-data directory, in `runtime`. Chain/keystore data is under `cypher/chaindbname`; transfer history is worker-owned `cypher/transfers.sqlite`. A process-held SQLite lock prevents simultaneous owners of the same state directory.

Installation does not move another CypherClaw/OpenClaw installation's data or history. Retain actual `CYPHER_DATADIR` and `CYPHER_IPC_PATH` only when deliberately using existing data, and stop its current process through its existing owner before changing owners. Test migration on a copy and retain backups. Default state is independent.

Wallet passwords and generated private keys are not stored in browser storage or transfer history. Generator output is transient and initially masked. Local bootstrap tokens and sessions are process-owned. The server binds **127.0.0.1 only**, checks Host/Origin, and uses an HttpOnly SameSite cookie. It exposes only its application assets and authenticated operations; it is not a remote administration service.

## Fixed native sources

`src/native/node-pins.ts` contains generated node sizes, hashes, and immutable commits. `src/native/pins.ts` owns the separately pinned wallet generator:

- Node: `CypherTroopers/cypher`; the generated node pins record the exact distribution and source commits for each build. Actions also includes those values in its native-source receipt.
- Wallet generator: `CypherTroopers/offlinewalletgenerator@629b3122aab207a7d7149439101c571a3360eecf`. Executables match the original retained release. Its historical source is `8879d9e4c0490999096bb299a0e2da31a1b20e50`; upstream later rewrote source fields. Original metadata is preserved; see THIRD_PARTY_NOTICES.

Setup stages bounded downloads privately and activates verified files. Errors are visible and retryable. Reverification requires stopping/disconnecting the node and finishing wallet generation. Availability of a binary is separate from full-chain validation on every OS.

## Refresh node binaries with GitHub Actions

In the standalone `CypherTroopers/node-app` repository, open **Actions → Node App Build → Run workflow**. Leave `upstream_ref` as `FHS-D` to use the current binaries from [`CypherTroopers/cypher/build/bin`](https://github.com/CypherTroopers/cypher/tree/FHS-D/build/bin), or enter an exact commit for a repeatable rebuild.

The workflow resolves that ref to one immutable commit, checks all three OS binaries and Windows DLLs against their repository SHA-256 records and required IPC contract, and generates the app's node pins. All three native build jobs consume the same prepared source snapshot. The resulting Actions artifacts contain the installers, checksums, and a native-source receipt. No native programs or DLLs are added to the application bundle or this repository. The independently pinned wallet generator is unchanged.

Running Actions again adopts the then-current `FHS-D` binaries for that new app build. There is no scheduled upstream monitoring, automatic source commit, or GitHub Release publication. Generated pins belong to the run's artifacts; the checked-in pins remain the local-build baseline until deliberately refreshed.

Users install the newly built application, stop or disconnect their node, and choose **Prepare node** to fetch its newly pinned version. Existing installations keep their previous pins until the application itself is replaced; they do not discover or install upstream updates automatically. Existing chain/keystore and transfer data stay separate from the versioned native program cache. Verify upgrade and chain compatibility before distributing a new build; checksum verification alone does not establish it.

To refresh the local-build baseline explicitly:

```sh
pnpm native:sync --ref FHS-D --receipt artifacts/native-sync.json
pnpm build
```

Review the generated pin change before committing. Sync downloads and hashes upstream files but never executes them. A failed check leaves the previous generated pins in place.

## Develop and package

Development requires supported Node.js (24.16+ on Node 24, or 26.1+) and the pinned pnpm via Corepack. This project has its own physical dependency installation and lockfile.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm start
```

If installing with `--ignore-scripts`, run the pinned Electron package's official `node node_modules/electron/install.js` before launching or packaging. Use its supported proxy settings in managed networks. The unused Squirrel.Windows hook is explicitly disabled; selected targets are portable EXE, DMG, and AppImage.

Build on each matching native host:

| Host        | Command           | Output                            |
| ----------- | ----------------- | --------------------------------- |
| Windows x64 | `pnpm dist:win`   | `release/*-win-x64.exe`           |
| macOS ARM64 | `pnpm dist:mac`   | `release/*-mac-arm64.dmg`         |
| Linux x64   | `pnpm dist:linux` | `release/*-linux-x86_64.AppImage` |

The packaging hook rejects mismatched hosts to ensure native dependencies are present. Commands use `--publish never`. Signing, notarization, release publication, and Windows/macOS device acceptance are separate tasks. See `VALIDATION.md` for observed checks and limitations. The desktop runtime makes this larger than the former plugin; native node downloads remain external.

For local server use, `node dist/cli.js --state-dir /absolute/isolated/path --port 0` runs the same backend and prints its private launch address. That URL grants local administrative access; keep it private. Ctrl+C settles owned resources. The desktop application needs no terminal step.
