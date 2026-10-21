import fs from "node:fs/promises";
import { CypherAuthorityError, createRequestAuthority } from "./authority.js";
import { CypherIpcError } from "./cypher/ipc.js";
import {
  CypherNodeManager,
  CypherOperationError,
  isCypherAddress,
  type CypherAuthority,
} from "./cypher/manager.js";
import { cypherAmountUnits } from "./cypher/transfer.js";
import { NativeSetupError } from "./native/index.js";
import { CypherAppService } from "./service.js";
import { WalletGeneratorError } from "./wallet-generator/manager.js";
type Validator<T> = (value: unknown) => value is T;

type EmptyParams = Record<string, never>;
type AddressParams = { address: string };
type PasswordParams = { password: string };
type MiningParams = { threads: number; signer: string; password: string };
type UnlockParams = AddressParams & PasswordParams & { duration: number };
type SignerParams = { signer: string };
type RewardParams = SignerParams & PasswordParams & { recipient: string };
type WalletListParams = { offset?: number; limit?: number };
type TransferListParams = { limit?: number };
type TransferPrepareParams = { from: string; to: string; amount: string };
type TransferSendParams = PasswordParams & { requestId: string; quoteId: string };

function exactParams(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function validPassword(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096;
}

function boundedInteger(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;
}

const emptyParams: Validator<EmptyParams> = (value): value is EmptyParams => exactParams(value, []);
const addressParams: Validator<AddressParams> = (value): value is AddressParams =>
  exactParams(value, ["address"]) && isCypherAddress(value.address);
const passwordParams: Validator<PasswordParams> = (value): value is PasswordParams =>
  exactParams(value, ["password"]) && validPassword(value.password);
const miningParams: Validator<MiningParams> = (value): value is MiningParams =>
  exactParams(value, ["threads", "signer", "password"]) &&
  boundedInteger(value.threads, 256) &&
  isCypherAddress(value.signer) &&
  validPassword(value.password);
const unlockParams: Validator<UnlockParams> = (value): value is UnlockParams =>
  exactParams(value, ["address", "password", "duration"]) &&
  isCypherAddress(value.address) &&
  validPassword(value.password) &&
  boundedInteger(value.duration, 86_400);
const signerParams: Validator<SignerParams> = (value): value is SignerParams =>
  exactParams(value, ["signer"]) && isCypherAddress(value.signer);
const rewardParams: Validator<RewardParams> = (value): value is RewardParams =>
  exactParams(value, ["signer", "recipient", "password"]) &&
  isCypherAddress(value.signer) &&
  isCypherAddress(value.recipient) &&
  value.signer.toLowerCase() !== value.recipient.toLowerCase() &&
  validPassword(value.password);
const walletListParams: Validator<WalletListParams> = (value): value is WalletListParams =>
  exactParams(value, ["offset", "limit"]) &&
  (value.offset === undefined ||
    (typeof value.offset === "number" &&
      Number.isInteger(value.offset) &&
      value.offset >= 0 &&
      value.offset <= 1024)) &&
  (value.limit === undefined || boundedInteger(value.limit, 50));
const transferListParams: Validator<TransferListParams> = (value): value is TransferListParams =>
  exactParams(value, ["limit"]) && (value.limit === undefined || boundedInteger(value.limit, 100));
const transferPrepareParams: Validator<TransferPrepareParams> = (
  value,
): value is TransferPrepareParams => {
  if (
    !exactParams(value, ["from", "to", "amount"]) ||
    !isCypherAddress(value.from) ||
    !isCypherAddress(value.to)
  ) {
    return false;
  }
  try {
    cypherAmountUnits(value.amount);
    return true;
  } catch {
    return false;
  }
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const transferSendParams: Validator<TransferSendParams> = (value): value is TransferSendParams =>
  exactParams(value, ["requestId", "quoteId", "password"]) &&
  typeof value.requestId === "string" &&
  uuidPattern.test(value.requestId) &&
  typeof value.quoteId === "string" &&
  uuidPattern.test(value.quoteId) &&
  validPassword(value.password);

export class AppOperationError extends Error {
  readonly details?: { code: string };

  constructor(
    readonly code: string,
    message: string,
    detailsCode?: string,
  ) {
    super(message);
    this.name = "AppOperationError";
    if (detailsCode) {
      this.details = { code: detailsCode };
    }
  }
}

function cypherError(error: unknown): AppOperationError {
  if (error instanceof AppOperationError) {
    return error;
  }
  if (
    error instanceof CypherAuthorityError ||
    (error instanceof CypherOperationError && error.code === "CYPHER_AUTHORITY_REVOKED")
  ) {
    return new AppOperationError("FORBIDDEN", error.message);
  }
  if (
    error instanceof CypherOperationError ||
    error instanceof WalletGeneratorError ||
    error instanceof CypherIpcError ||
    error instanceof NativeSetupError
  ) {
    return new AppOperationError("UNAVAILABLE", error.message, String(error.code));
  }
  return new AppOperationError(
    "UNAVAILABLE",
    "Cypher operation failed. Check the node status and try again.",
  );
}

type Operation = { run(params: unknown, authority: CypherAuthority): Promise<unknown> };

/** One validated business-operation boundary shared by the desktop and local HTTP transport. */
export class CypherOperations {
  readonly #operations = new Map<string, Operation>();
  readonly methods: readonly string[];

  constructor(readonly service: CypherAppService) {
    const register = <T>(
      method: string,
      kind: "read" | "mutation",
      validate: Validator<T>,
      operation: (
        owners: ReturnType<CypherAppService["current"]>,
        params: T,
        authority: CypherAuthority,
      ) => Promise<unknown>,
    ) => {
      this.#operations.set(method, {
        run: async (value, session) => {
          if (!validate(value)) {
            throw new AppOperationError("INVALID_REQUEST", "Invalid Cypher operation parameters.");
          }
          const params = value;
          const owners = service.current();
          const authority = createRequestAuthority(session, owners.signal);
          authority.assertCurrent();
          const result =
            kind === "mutation"
              ? await service.mutate(owners, authority, () => operation(owners, params, authority))
              : await operation(owners, params, authority);
          authority.assertCurrent();
          return result;
        },
      });
    };

    function mutation<T>(
      method: string,
      validate: Validator<T>,
      operation: (
        manager: CypherNodeManager,
        params: T,
        authority: CypherAuthority,
      ) => Promise<unknown>,
    ) {
      register(method, "mutation", validate, (owners, params, authority) =>
        operation(owners.node, params, authority),
      );
    }

    register("cypher.status", "read", emptyParams, (owners) => owners.node.status());
    register("cypher.setup.status", "read", emptyParams, (owners) => owners.installer.status());
    register("cypher.setup.prepare", "mutation", emptyParams, (owners, _params, authority) =>
      service.prepare(owners, authority),
    );
    register("cypher.start", "mutation", emptyParams, async (owners, _params, authority) => {
      const selectedRoot = (await owners.node.status()).rootDir;
      const managedRoot =
        process.platform === "win32"
          ? owners.installer.nodeRoot
          : await fs.realpath(owners.installer.nodeRoot).catch((error: unknown) => {
              if (error instanceof Error && "code" in error && error.code === "ENOENT")
                return owners.installer.nodeRoot;
              throw error;
            });
      const managed =
        process.platform === "win32"
          ? selectedRoot.toLowerCase() === managedRoot.toLowerCase()
          : selectedRoot === managedRoot;
      if (managed && !(await owners.installer.status()).node.ready) {
        throw new CypherOperationError(
          "Choose Prepare node to install or refresh the current launch files before starting.",
        );
      }
      authority.assertCurrent();
      return owners.node.start(authority);
    });
    mutation("cypher.stop", emptyParams, (manager, _params, authority) => manager.stop(authority));
    mutation("cypher.connect", emptyParams, (manager, _params, authority) =>
      manager.connect(authority),
    );
    mutation("cypher.disconnect", emptyParams, (manager, _params, authority) =>
      manager.disconnect(authority),
    );
    mutation("cypher.mining.start", miningParams, (manager, params, authority) =>
      manager.startMining(params, authority),
    );
    mutation("cypher.mining.stop", emptyParams, (manager, _params, authority) =>
      manager.stopMining(authority),
    );
    mutation("cypher.accounts.create", passwordParams, (manager, params, authority) =>
      manager.createAccount(params.password, authority),
    );
    mutation("cypher.accounts.select", addressParams, (manager, params, authority) =>
      manager.selectAccount(params.address, authority),
    );
    mutation("cypher.accounts.unlock", unlockParams, (manager, params, authority) =>
      manager.unlockAccount(params, authority),
    );
    mutation("cypher.accounts.lock", addressParams, (manager, params, authority) =>
      manager.lockAccount(params.address, authority),
    );
    mutation("cypher.reward.get", signerParams, (manager, params, authority) =>
      manager.getReward(params.signer, authority),
    );
    mutation("cypher.reward.set", rewardParams, (manager, params, authority) =>
      manager.setReward(params, authority),
    );
    register("cypher.wallets.list", "read", walletListParams, (owners, params) =>
      owners.node.wallets(params),
    );
    mutation("cypher.transfers.prepare", transferPrepareParams, (manager, params, authority) =>
      manager.prepareTransfer(params, authority),
    );
    mutation("cypher.transfers.send", transferSendParams, (manager, params, authority) =>
      manager.sendTransfer(params, authority),
    );
    register("cypher.transfers.list", "read", transferListParams, (owners, params) =>
      owners.node.transfers(params),
    );
    register("cypher.wallet.generator.status", "read", emptyParams, (owners) =>
      owners.wallet.status(),
    );
    register(
      "cypher.wallet.generator.generate",
      "mutation",
      emptyParams,
      (owners, _params, authority) => owners.wallet.generate(authority),
    );
    this.methods = Object.freeze([...this.#operations.keys()]);
  }

  async request(method: string, params: unknown, authority: CypherAuthority): Promise<unknown> {
    try {
      try {
        authority.signal?.throwIfAborted();
        authority.assertCurrent();
      } catch {
        throw new CypherAuthorityError();
      }
      const operation = this.#operations.get(method);
      if (!operation) {
        throw new AppOperationError("METHOD_NOT_FOUND", "Unknown Cypher operation.");
      }
      return await operation.run(params, authority);
    } catch (error) {
      throw cypherError(error);
    }
  }
}
