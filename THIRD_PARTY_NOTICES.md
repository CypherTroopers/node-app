# Third-party notices

The application's MIT license retains the original OpenClaw Foundation copyright. It covers the derived application code and does not replace third-party licenses or brand rights. Attribution does not make OpenClaw a runtime dependency or imply official endorsement.

## Bundled browser and runtime libraries

Browser code includes Lit 3.3.3, lit-html 3.3.3, lit-element 4.2.2, and @lit/reactive-element 2.1.2 under BSD-3-Clause. Original texts are retained in `assets/browser-licenses/`. The original CypherClaw PNG artwork is retained without modification.

The backend bundles Kysely 0.29.6 (MIT). Original legal comments are retained, and the build collects dependency license texts in `assets/runtime-licenses/`. The desktop distribution includes Electron/Chromium and pinned @lydell/node-pty with its platform packages and accompanying notices. These desktop runtime components contain native code. There is no MCP bridge in the standalone application.

## Native runtime fetched separately

The application does not contain Cypher node programs, wallet executables, node-specific Windows DLLs, or corresponding-source archives. It contains static launch/configuration assets and license notices needed to prepare the selected node runtime. Electron's own runtime and native dependencies are packaged separately from those on-demand node downloads.

The node's immutable distribution is `CypherTroopers/cypher@9ca4b9793d6e3527f4439ab4cc29a500a160c134`, with build source `546d43442e8156591786dc3c1ca1596f014509e3`. Setup downloads original upstream executable bytes and provenance records, without patching or rebuilding them. Cypher node code includes GPL-3.0-or-later and LGPL-3.0-or-later components. Go, GMP, Herumi, OpenSSL, GCC runtime, and MinGW-w64 components retain their separate licenses. Included texts are under `assets/cypher/licenses/`; authoritative source and build/provenance records remain in the pinned upstream repository. This package makes no claim that upstream native corresponding-source and relinking materials have been independently completed or legally certified.

The independent wallet's available immutable artifact commit is `CypherTroopers/offlinewalletgenerator@629b3122aab207a7d7149439101c571a3360eecf`. All six downloaded executable SHA-256 digests match the retained original distribution exactly. Original build metadata records source `8879d9e4c0490999096bb299a0e2da31a1b20e50` and now-unavailable distribution `63dfd53949c5b7523e42369251512fd7e8a2f0d6`. The available repository's build-info records identify a different source, `031b794df183e6202ded219020480254627ec19b`; this is not treated as evidence of a changed executable or independently verified build source. Setup copies the original retained build-info files from `assets/native/` and verifies exact executable hashes. Original wallet license and dependency notices remain under `assets/wallet-generator/`.

Source ownership, distribution history, and public registry review are separate from byte-integrity verification. The historical source metadata discrepancy is recorded rather than silently rewriting the wallet's runtime source contract.
