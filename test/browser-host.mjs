// Deterministic RPC fixture used only after the real local server authenticates a browser.
// No native process, funds, mining, or external chain is contacted by these scenarios.
export function createNodeFixture({ missing = false } = {}) {
  const signer = `0x${"1".repeat(40)}`;
  const second = `0x${"2".repeat(40)}`;
  const network = {
    chainId: "0x9a249f",
    genesisHash: "0x001c8239f25a697933e2a54511a576205fb21cbb80dc974adb29894dc80250ad",
    currency: "CLX",
    decimals: 18,
  };
  const pin = {
    repository: "fixture/native",
    distributionCommit: "0".repeat(40),
    sourceCommit: "1".repeat(40),
  };
  const setup = {
    state: missing ? "missing" : "ready",
    target: "linux-amd64",
    node: {
      supported: true,
      ready: !missing,
      pin,
    },
    wallet: {
      supported: true,
      ready: !missing,
      pin,
    },
    progress: null,
    error: null,
  };
  const nodeSnapshot = {
    clientVersion: "fixture",
    chainId: network.chainId,
    blockNumber: "0x20000000000001",
    peerCount: "0xa",
    mining: false,
    hashrate: "0x0",
    accounts: [signer, second],
    signer,
  };
  const status = {
    platform: "linux",
    arch: "x64",
    supported: setup.node.supported,
    rootDir: "/fixture/cypher",
    dataDir: "/fixture/data",
    binaryPath: "/fixture/cypher-linux-amd64",
    ipcPath: "/fixture/cypher.ipc",
    state: setup.node.ready ? "running" : "stopped",
    owned: setup.node.ready,
    connected: setup.node.ready,
    pid: setup.node.ready ? 123 : null,
    logs: ["Synthetic ColossusX node started", "IPC connected; finality available"],
    error: null,
    node: setup.node.ready ? nodeSnapshot : null,
  };
  const wallets = {
    network,
    wallets: [
      { address: signer, balance: "12.5", balanceWei: "0xad78ebc5ac620000", locked: true },
      { address: second, balance: "0.000000000000000001", balanceWei: "0x1", locked: false },
    ],
    total: 2,
    offset: 0,
    limit: 25,
    readiness: { ready: true, reason: null },
    finalitySupported: true,
  };
  const quote = {
    quoteId: "cb450290-8a90-4226-b8fc-c82565159dcf",
    network,
    from: second,
    to: signer,
    amount: "0.000000000000000001",
    value: "0x1",
    nonce: "0x2",
    gas: "0x5208",
    gasPrice: "0x1",
    estimatedFee: "0.000000000000021",
    total: "0.000000000000021001",
    expiresAt: 4102444800000,
  };
  const transfer = {
    ...quote,
    requestId: "49b4f708-85cb-49c7-85a2-2b0d41496a8c",
    nodeKey: "fixture-node",
    hash: `0x${"a".repeat(64)}`,
    status: "included",
    finalitySupported: true,
    blockNumber: "0x2",
    actualFee: "0.000000000000021",
    errorCode: null,
    createdAt: 1,
    updatedAt: 2,
  };
  const transfers = [];
  const wallet = {
    address: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
    privateKey: `0x${"0".repeat(63)}1`,
  }; // Public scalar-one vector.
  const requests = [];
  let finishSetup;
  async function request(method, params = {}) {
    requests.push({ method, params: structuredClone(params) });
    if (method === "cypher.setup.status") {
      return structuredClone(setup);
    }
    if (method === "cypher.setup.prepare") {
      setup.state = "preparing";
      setup.error = null;
      setup.progress = {
        file: "node",
        downloadedBytes: 1048576,
        totalBytes: 2097152,
        completedFiles: 1,
        totalFiles: 3,
      };
      return new Promise((resolve, reject) => {
        finishSetup = (failure = false) => {
          setup.state = failure ? "error" : "ready";
          setup.error = failure
            ? {
                code: "download",
                message:
                  "Native tools could not be downloaded. Check this computer's network and retry setup.",
              }
            : null;
          setup.node.ready = !failure && setup.node.supported;
          setup.wallet.ready = !failure && setup.wallet.supported;
          setup.progress = null;
          if (failure) {
            reject(new Error(setup.error.message));
          } else {
            resolve(structuredClone(setup));
          }
        };
      });
    }
    if (method === "cypher.status") {
      return structuredClone(status);
    }
    if (["cypher.start", "cypher.connect"].includes(method)) {
      Object.assign(status, {
        state: "running",
        owned: method === "cypher.start",
        connected: true,
        pid: 123,
        node: nodeSnapshot,
      });
      return structuredClone(status);
    }
    if (["cypher.stop", "cypher.disconnect"].includes(method)) {
      Object.assign(status, {
        state: "stopped",
        owned: false,
        connected: false,
        pid: null,
        node: null,
      });
      return structuredClone(status);
    }
    if (method === "cypher.wallets.list") {
      return structuredClone(wallets);
    }
    if (method === "cypher.accounts.create") {
      return { address: second };
    }
    if (method === "cypher.accounts.lock") {
      return { locked: true };
    }
    if (method === "cypher.accounts.unlock") {
      return { unlocked: true };
    }
    if (method === "cypher.accounts.select") {
      status.node.signer = params.address;
      return structuredClone(status);
    }
    if (["cypher.mining.start", "cypher.mining.stop"].includes(method)) {
      return structuredClone(status);
    }
    if (["cypher.reward.get", "cypher.reward.set"].includes(method)) {
      return { signer, configured: true, rewardRecipient: second };
    }
    if (method === "cypher.transfers.prepare") {
      return structuredClone(quote);
    }
    if (method === "cypher.transfers.send") {
      const result = { ...transfer, requestId: params.requestId };
      transfers.push(result);
      return structuredClone(result);
    }
    if (method === "cypher.transfers.list") {
      return { transfers: structuredClone(transfers) };
    }
    if (method === "cypher.wallet.generator.status") {
      return {
        platform: "linux",
        arch: status.arch,
        supported: setup.wallet.supported,
        available: setup.wallet.ready,
        binaryPath: "/fixture/coldwalletgenerator",
        sourceCommit: "0".repeat(40),
        error: null,
      };
    }
    if (method === "cypher.wallet.generator.generate") {
      return structuredClone(wallet);
    }
    throw new Error(`Unexpected request: ${method}`);
  }
  return {
    requests,
    request,
    finishSetup(failure = false) {
      finishSetup(failure);
    },
    finality() {
      transfers.forEach((row) => {
        row.status = "complete";
      });
    },
  };
}
