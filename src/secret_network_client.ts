import { fromBase64, fromUtf8, toHex } from "@cosmjs/encoding";
import { Tendermint34Client } from "@cosmjs/tendermint-rpc";
import { Coin, OfflineSigner } from ".";
import { EncryptionUtils, EncryptionUtilsImpl } from "./encryption";
import { AuthQuerier } from "./query/auth";
import { ComputeQuerier } from "./query/compute";
import { AminoMsg, Msg, ProtoMsg } from "./tx/types";
import {
  AccountData,
  AminoSignResponse,
  encodeSecp256k1Pubkey,
  isOfflineDirectSigner,
  OfflineAminoSigner,
  Pubkey,
  StdFee,
  StdSignDoc,
} from "./wallet";

export type SigningParams = {
  signerAddress: string;
  signer: OfflineSigner;
  chainId: string;
  /** Passing `encryptionSeed` will allow tx decryption at a later time. Ignored if `encryptionUtils` is supplied. */
  encryptionSeed?: Uint8Array;
  /** `encryptionUtils` overrides the default {@link EncryptionUtilsImpl}. */
  encryptionUtils?: EncryptionUtils;
};

export enum BroadcastMode {
  /**
   * Broadcast transaction to mempool and wait for CheckTx response.
   *
   * @see https://docs.tendermint.com/master/rpc/#/Tx/broadcast_tx_sync
   */
  Sync,
  /**
   * Broadcast transaction to mempool and do not wait for CheckTx response.
   *
   * @see https://docs.tendermint.com/master/rpc/#/Tx/broadcast_tx_async
   */
  Async,
}

export type SignAndBroadcastParams = {
  gasLimit: number;
  /** E.g. gasPriceInFeeDenom=0.25 & feeDenom="uscrt" => Total fee for tx is `0.25 * gasLimit`uscrt  */
  gasPriceInFeeDenom: number;
  /** E.g. "uscrt" */
  feeDenom: string;
  memo?: string;
  /** If false returns immediately with `transactionHash`. Defaults to `true`. */
  waitForCommit?: boolean;
  /**
   * How much time (in milliseconds) to wait for tx to commit on-chain.
   *
   * Defaults to `60_000`. Ignored if `waitForCommit = false`.
   */
  broadcastTimeoutMs?: number;
  /**
   * When waiting for tx to commit on-chain, this how much time (in milliseconds) to wait between checking if the tx is committed on-chain.
   *
   * Smaller intervals will cause more load on your node provider. Keep in mind that blocks on Secret Network take about 6 seconds to commit.
   *
   * Defaults to `6_000`. Ignored if `waitForCommit = false`.
   */
  broadcastCheckIntervalMs?: number;
  /**
   * If `BroadcastMode.Sync` - Broadcast transaction to mempool and wait for CheckTx response.
   *
   * @see https://docs.tendermint.com/master/rpc/#/Tx/broadcast_tx_sync
   *
   * If `BroadcastMode.Async` Broadcast transaction to mempool and do not wait for CheckTx response.
   *
   * @see https://docs.tendermint.com/master/rpc/#/Tx/broadcast_tx_async
   */
  broadcastMode?: BroadcastMode;
  /**
   * explicitSignerData can be used to override `chainId`, `accountNumber` & `accountSequence`.
   * This is usefull when using {@link BroadcastMode.Async} or when you don't want secretjs
   * to query for `accountNumber` & `accountSequence` from the chain. (smoother in UIs, less load on your node provider).
   */
  explicitSignerData?: SignerData;
};

/**
 * Signing information for a single signer that is not included in the transaction.
 *
 * @see https://github.com/cosmos/cosmos-sdk/blob/v0.42.2/x/auth/signing/sign_mode_handler.go#L23-L37
 */
export interface SignerData {
  readonly accountNumber: number;
  readonly sequence: number;
  readonly chainId: string;
}

export class ReadonlySigner implements OfflineAminoSigner {
  getAccounts(): Promise<readonly AccountData[]> {
    throw new Error("getAccounts() is not supported in readonly mode.");
  }
  signAmino(
    _signerAddress: string,
    _signDoc: StdSignDoc,
  ): Promise<AminoSignResponse> {
    throw new Error("signAmino() is not supported in readonly mode.");
  }
}

type Querier = {
  auth: AuthQuerier;
  authz: import("./protobuf_stuff/cosmos/authz/v1beta1/query").QueryClientImpl;
  bank: import("./protobuf_stuff/cosmos/bank/v1beta1/query").QueryClientImpl;
  compute: ComputeQuerier;
  distribution: import("./protobuf_stuff/cosmos/distribution/v1beta1/query").QueryClientImpl;
  evidence: import("./protobuf_stuff/cosmos/evidence/v1beta1/query").QueryClientImpl;
  feegrant: import("./protobuf_stuff/cosmos/feegrant/v1beta1/query").QueryClientImpl;
  gov: import("./protobuf_stuff/cosmos/gov/v1beta1/query").QueryClientImpl;
  ibc_channel: import("./protobuf_stuff/ibc/core/channel/v1/query").QueryClientImpl;
  ibc_client: import("./protobuf_stuff/ibc/core/client/v1/query").QueryClientImpl;
  ibc_connection: import("./protobuf_stuff/ibc/core/connection/v1/query").QueryClientImpl;
  ibc_transfer: import("./protobuf_stuff/ibc/applications/transfer/v1/query").QueryClientImpl;
  mint: import("./protobuf_stuff/cosmos/mint/v1beta1/query").QueryClientImpl;
  params: import("./protobuf_stuff/cosmos/params/v1beta1/query").QueryClientImpl;
  registration: import("./protobuf_stuff/secret/registration/v1beta1/query").QueryClientImpl;
  slashing: import("./protobuf_stuff/cosmos/slashing/v1beta1/query").QueryClientImpl;
  staking: import("./protobuf_stuff/cosmos/staking/v1beta1/query").QueryClientImpl;
  tendermint: import("./protobuf_stuff/cosmos/base/tendermint/v1beta1/query").ServiceClientImpl;
  upgrade: import("./protobuf_stuff/cosmos/upgrade/v1beta1/query").QueryClientImpl;
  getTx: (id: string) => Promise<IndexedTx | null>;
  txsQuery: (query: string) => Promise<IndexedTx[]>;
};

export type ArrayLog = Array<{
  msg: number;
  type: string;
  key: string;
  value: string;
}>;

export type JsonLog = Array<{
  events: Array<{
    type: string;
    attributes: Array<{ key: string; value: string }>;
  }>;
}>;

/**
 * MsgData defines the data returned in a Result object during message
 * execution.
 */
export type MsgData = {
  msgType: string;
  data: Uint8Array;
};

/**
 * The response after successfully broadcasting a transaction.
 */
export type DeliverTxResponse = {
  readonly height?: number;
  /** Error code. The transaction suceeded iff code is 0. */
  readonly code?: number;
  readonly transactionHash: string;
  /**
   * If code != 0, rawLog contains the error.
   *
   * If code = 0 you'll probably want to use `jsonLog` or `arrayLog`. Values are not decrypted.
   */
  readonly rawLog?: string;
  /** If code = 0, `jsonLog = JSON.parse(rawLow)`. Values are decrypted if possible. */
  readonly jsonLog?: JsonLog;
  /** If code = 0, `arrayLog` is a flattened `jsonLog`. Values are decrypted if possible. */
  readonly arrayLog?: ArrayLog;
  readonly data?: MsgData[];
  readonly gasUsed?: number;
  readonly gasWanted?: number;
};

/** A transaction that is indexed as part of the transaction history */
export interface IndexedTx {
  readonly height: number;
  /** Transaction hash (might be used as transaction ID). Guaranteed to be non-empty upper-case hex */
  readonly hash: string;
  /** Transaction execution error code. 0 on success. */
  readonly code: number;
  readonly rawLog: string;
  /** If code = 0, `jsonLog = JSON.parse(rawLow)`. Values are decrypted if possible. */
  readonly jsonLog?: JsonLog;
  /** If code = 0, `arrayLog` is a flattened `jsonLog`. Values are decrypted if possible. */
  readonly arrayLog?: ArrayLog;
  /**
   * Raw transaction bytes stored in Tendermint.
   *
   * If you hash this, you get the transaction hash (= transaction ID):
   *
   * ```js
   * import { sha256 } from "@noble/hashes/sha256";
   * import { toHex } from "@cosmjs/encoding";
   *
   * const transactionId = toHex(sha256(indexTx.tx)).toUpperCase();
   * ```
   *
   * Use `decodeTxRaw` from @cosmjs/proto-signing to decode this.
   */
  readonly tx: Uint8Array;
  readonly gasUsed: number;
  readonly gasWanted: number;
}

type TxSender = {
  broadcast: (
    messages: Msg[],
    params: SignAndBroadcastParams,
  ) => Promise<DeliverTxResponse>;
};

interface SecretRpcClient {
  request(
    service: string,
    method: string,
    data: Uint8Array,
  ): Promise<Uint8Array>;
}

type ComputeMsgToNonce = { [msgIndex: number]: Uint8Array };

export class SecretNetworkClient {
  public query: Querier;
  public tx: TxSender;
  public tendermint: Tendermint34Client;
  private signerAddress: string;
  private signer: OfflineSigner;
  private chainId: string;
  private encryptionUtils: EncryptionUtils;

  /** Creates a new SecretNetworkClient client. For a readonly client pass just the `rpcUrl` param. */
  public static async create(
    rpcUrl: string,
    signingParams: SigningParams = {
      signer: new ReadonlySigner(),
      chainId: "",
      signerAddress: "",
    },
  ): Promise<SecretNetworkClient> {
    const tendermint = await Tendermint34Client.connect(rpcUrl);

    // Init this.query in here because we need async/await for dynamic imports
    const rpc: SecretRpcClient = {
      request: async (
        service: string,
        method: string,
        data: Uint8Array,
      ): Promise<Uint8Array> => {
        const path = `/${service}/${method}`;

        const response = await tendermint.abciQuery({
          path,
          data,
          prove: false,
        });

        if (response.code) {
          throw new Error(
            `Query failed with (${response.code}): ${response.log}`,
          );
        }

        return response.value;
      },
    };

    const query: Querier = {
      auth: new AuthQuerier(rpc),
      authz: new (
        await import("./protobuf_stuff/cosmos/authz/v1beta1/query")
      ).QueryClientImpl(rpc),
      bank: new (
        await import("./protobuf_stuff/cosmos/bank/v1beta1/query")
      ).QueryClientImpl(rpc),
      compute: new ComputeQuerier(rpc),
      distribution: new (
        await import("./protobuf_stuff/cosmos/distribution/v1beta1/query")
      ).QueryClientImpl(rpc),
      evidence: new (
        await import("./protobuf_stuff/cosmos/evidence/v1beta1/query")
      ).QueryClientImpl(rpc),
      feegrant: new (
        await import("./protobuf_stuff/cosmos/feegrant/v1beta1/query")
      ).QueryClientImpl(rpc),
      gov: new (
        await import("./protobuf_stuff/cosmos/gov/v1beta1/query")
      ).QueryClientImpl(rpc),
      ibc_channel: new (
        await import("./protobuf_stuff/ibc/core/channel/v1/query")
      ).QueryClientImpl(rpc),
      ibc_client: new (
        await import("./protobuf_stuff/ibc/core/client/v1/query")
      ).QueryClientImpl(rpc),
      ibc_connection: new (
        await import("./protobuf_stuff/ibc/core/connection/v1/query")
      ).QueryClientImpl(rpc),
      ibc_transfer: new (
        await import("./protobuf_stuff/ibc/applications/transfer/v1/query")
      ).QueryClientImpl(rpc),
      mint: new (
        await import("./protobuf_stuff/cosmos/mint/v1beta1/query")
      ).QueryClientImpl(rpc),
      params: new (
        await import("./protobuf_stuff/cosmos/params/v1beta1/query")
      ).QueryClientImpl(rpc),
      registration: new (
        await import("./protobuf_stuff/secret/registration/v1beta1/query")
      ).QueryClientImpl(rpc),
      slashing: new (
        await import("./protobuf_stuff/cosmos/slashing/v1beta1/query")
      ).QueryClientImpl(rpc),
      staking: new (
        await import("./protobuf_stuff/cosmos/staking/v1beta1/query")
      ).QueryClientImpl(rpc),
      tendermint: new (
        await import("./protobuf_stuff/cosmos/base/tendermint/v1beta1/query")
      ).ServiceClientImpl(rpc),
      upgrade: new (
        await import("./protobuf_stuff/cosmos/upgrade/v1beta1/query")
      ).QueryClientImpl(rpc),
      getTx: async () => null, // stub until we can set this in the constructor
      txsQuery: async () => [], // stub until we can set this in the constructor
    };

    return new SecretNetworkClient(tendermint, query, signingParams);
  }

  private constructor(
    tendermint: Tendermint34Client,
    query: Querier,
    signingParams: SigningParams,
  ) {
    this.tendermint = tendermint;

    this.query = query;
    this.query.getTx = this.getTx.bind(this);
    this.query.txsQuery = this.txsQuery.bind(this);

    this.signer = signingParams.signer;
    this.chainId = signingParams.chainId;
    this.signerAddress = signingParams.signerAddress;

    const rpc: SecretRpcClient = {
      request: async (
        service: string,
        method: string,
        data: Uint8Array,
      ): Promise<Uint8Array> => {
        const path = `/${service}/${method}`;

        const response = await tendermint.abciQuery({
          path,
          data,
          prove: false,
        });

        if (response.code) {
          throw new Error(
            `Query failed with (${response.code}): ${response.log}`,
          );
        }

        return response.value;
      },
    };

    this.tx = {
      broadcast: this.signAndBroadcast.bind(this),
    };

    if (signingParams.encryptionUtils) {
      this.encryptionUtils = signingParams.encryptionUtils;
    } else {
      this.encryptionUtils = new EncryptionUtilsImpl(
        this.query.registration,
        signingParams.encryptionSeed,
        this.chainId,
      );
    }
  }

  private async getTx(id: string): Promise<IndexedTx | null> {
    const results = await this.txsQuery(`tx.hash='${id}'`);
    return results[0] ?? null;
  }

  private async txsQuery(query: string): Promise<IndexedTx[]> {
    const results = await this.tendermint.txSearchAll({ query: query });
    return results.txs.map((tx) => {
      return {
        height: tx.height,
        hash: toHex(tx.hash).toUpperCase(),
        code: tx.result.code,
        rawLog: tx.result.log || "",
        tx: tx.tx,
        gasUsed: tx.result.gasUsed,
        gasWanted: tx.result.gasWanted,
      };
    });
  }

  /**
   * Broadcasts a signed transaction to the network and monitors its inclusion in a block.
   *
   * If broadcasting is rejected by the node for some reason (e.g. because of a CheckTx failure),
   * an error is thrown.
   *
   * If the transaction is not included in a block before the provided timeout, this errors with a `TimeoutError`.
   *
   * If the transaction is included in a block, a {@link DeliverTxResponse} is returned. The caller then
   * usually needs to check for execution success or failure.
   */
  private async broadcastTx(
    tx: Uint8Array,
    timeoutMs: number,
    checkIntervalMs: number,
    mode: BroadcastMode,
    waitForCommit: boolean,
    nonces: ComputeMsgToNonce,
  ): Promise<DeliverTxResponse> {
    const start = Date.now();

    let txhash: string;
    if (mode === BroadcastMode.Sync) {
      const broadcasted = await this.tendermint.broadcastTxSync({ tx });
      if (broadcasted.code) {
        throw new Error(
          `Broadcasting transaction failed with code ${broadcasted.code} (codespace: ${broadcasted.codeSpace}). Log: ${broadcasted.log}`,
        );
      }
      txhash = toHex(broadcasted.hash).toUpperCase();
    } else {
      const broadcasted = await this.tendermint.broadcastTxAsync({ tx });
      txhash = toHex(broadcasted.hash).toUpperCase();
    }

    if (!waitForCommit) {
      return { transactionHash: txhash };
    }

    while (true) {
      if (start + timeoutMs < Date.now()) {
        throw new Error(
          `Transaction ID ${txhash} was submitted but was not yet found on the chain. You might want to check later.`,
        );
      }

      const result = await this.getTx(txhash);
      if (result) {
        let jsonLog: JsonLog | undefined;
        let arrayLog: ArrayLog | undefined;
        if (result.code == 0) {
          jsonLog = JSON.parse(result.rawLog) as JsonLog;

          arrayLog = [];
          for (let msgIndex = 0; msgIndex < jsonLog.length; msgIndex++) {
            const log = jsonLog[msgIndex];
            for (const event of log.events) {
              for (const attr of event.attributes) {
                // Try to decrypt
                if (event.type === "wasm") {
                  const nonce = nonces[msgIndex];
                  if (nonce) {
                    try {
                      attr.key = fromUtf8(
                        await this.encryptionUtils.decrypt(
                          fromBase64(attr.key),
                          nonce,
                        ),
                      ).trim();
                    } catch (e) {}
                    try {
                      attr.value = fromUtf8(
                        await this.encryptionUtils.decrypt(
                          fromBase64(attr.value),
                          nonce,
                        ),
                      ).trim();
                    } catch (e) {}
                  }
                }

                arrayLog.push({
                  msg: msgIndex,
                  type: event.type,
                  key: attr.key,
                  value: attr.value,
                });
              }
            }
          }
        }

        return {
          code: result.code,
          height: result.height,
          rawLog: result.rawLog,
          jsonLog,
          arrayLog,
          transactionHash: txhash,
          gasUsed: result.gasUsed,
          gasWanted: result.gasWanted,
        };
      }

      await sleep(checkIntervalMs);
    }
  }

  private async signAndBroadcast(
    messages: Msg[],
    {
      gasLimit,
      gasPriceInFeeDenom,
      feeDenom,
      memo = "",
      waitForCommit = true,
      broadcastTimeoutMs = 60_000,
      broadcastCheckIntervalMs = 6_000,
      broadcastMode = BroadcastMode.Sync,
      explicitSignerData,
    }: SignAndBroadcastParams,
  ): Promise<DeliverTxResponse> {
    const [txRaw, nonces] = await this.sign(
      messages,
      {
        gas: String(gasLimit),
        amount: [
          {
            amount: String(gasToFee(gasLimit, gasPriceInFeeDenom)),
            denom: feeDenom,
          },
        ],
      },
      memo,
      explicitSignerData,
    );
    const txBytes = (
      await import("./protobuf_stuff/cosmos/tx/v1beta1/tx")
    ).TxRaw.encode(txRaw).finish();

    return this.broadcastTx(
      txBytes,
      broadcastTimeoutMs,
      broadcastCheckIntervalMs,
      broadcastMode,
      waitForCommit,
      nonces,
    );
  }

  /**
   * Gets account number and sequence from the API, creates a sign doc,
   * creates a single signature and assembles the signed transaction.
   *
   * The sign mode (SIGN_MODE_DIRECT or SIGN_MODE_LEGACY_AMINO_JSON) is determined by this client's signer.
   *
   * You can pass signer data (account number, sequence and chain ID) explicitly instead of querying them
   * from the chain. This is needed when signing for a multisig account, but it also allows for offline signing
   * (See the SigningStargateClient.offline constructor).
   */
  private async sign(
    messages: Msg[],
    fee: StdFee,
    memo: string,
    explicitSignerData?: SignerData,
  ): Promise<
    [import("./protobuf_stuff/cosmos/tx/v1beta1/tx").TxRaw, ComputeMsgToNonce]
  > {
    let signerData: SignerData;
    if (explicitSignerData) {
      signerData = explicitSignerData;
    } else {
      const account = await this.query.auth.account({
        address: this.signerAddress,
      });

      if (!account) {
        throw new Error(
          `Cannot find account "${this.signerAddress}", make sure it has a balance.`,
        );
      }

      if (account.type !== "BaseAccount") {
        throw new Error(
          `Cannot sign with account of type "${account.type}", can only sign with "BaseAccount".`,
        );
      }

      const chainId = this.chainId;
      signerData = {
        accountNumber: Number(
          (
            account.account as import("./protobuf_stuff/cosmos/auth/v1beta1/auth").BaseAccount
          ).accountNumber,
        ),
        sequence: Number(
          (
            account.account as import("./protobuf_stuff/cosmos/auth/v1beta1/auth").BaseAccount
          ).sequence,
        ),
        chainId: chainId,
      };
    }

    return isOfflineDirectSigner(this.signer)
      ? this.signDirect(this.signerAddress, messages, fee, memo, signerData)
      : this.signAmino(this.signerAddress, messages, fee, memo, signerData);
  }

  private async signAmino(
    signerAddress: string,
    messages: Msg[],
    fee: StdFee,
    memo: string,
    { accountNumber, sequence, chainId }: SignerData,
  ): Promise<
    [import("./protobuf_stuff/cosmos/tx/v1beta1/tx").TxRaw, ComputeMsgToNonce]
  > {
    if (isOfflineDirectSigner(this.signer)) {
      throw new Error("Wrong signer type! Expected AminoSigner.");
    }

    const accountFromSigner = (await this.signer.getAccounts()).find(
      (account) => account.address === signerAddress,
    );
    if (!accountFromSigner) {
      throw new Error("Failed to retrieve account from signer");
    }

    const signMode = (
      await import("./protobuf_stuff/cosmos/tx/signing/v1beta1/signing")
    ).SignMode.SIGN_MODE_LEGACY_AMINO_JSON;
    const msgs = await Promise.all(
      messages.map((msg) => msg.toAmino(this.encryptionUtils)),
    );
    const signDoc = makeSignDocAmino(
      msgs,
      fee,
      chainId,
      memo,
      accountNumber,
      sequence,
    );
    const { signature, signed } = await this.signer.signAmino(
      signerAddress,
      signDoc,
    );
    const encryptionNonces: ComputeMsgToNonce = {};
    const txBody = {
      typeUrl: "/cosmos.tx.v1beta1.TxBody",
      value: {
        messages: await Promise.all(
          messages.map(async (msg, index) => {
            const asProto = await msg.toProto(this.encryptionUtils);
            if (
              asProto.typeUrl ===
              "/secret.compute.v1beta1.MsgInstantiateContract"
            ) {
              encryptionNonces[index] = asProto.value.initMsg.slice(0, 32);
            }
            if (
              asProto.typeUrl === "/secret.compute.v1beta1.MsgExecuteContract"
            ) {
              encryptionNonces[index] = asProto.value.msg.slice(0, 32);
            }

            return asProto;
          }),
        ),
        memo: memo,
      },
    };
    const txBodyBytes = await this.encodeTx(txBody);
    const signedGasLimit = Number(signed.fee.gas);
    const signedSequence = Number(signed.sequence);
    const pubkey = await encodePubkey(
      encodeSecp256k1Pubkey(accountFromSigner.pubkey),
    );
    const signedAuthInfoBytes = await makeAuthInfoBytes(
      [{ pubkey, sequence: signedSequence }],
      signed.fee.amount,
      signedGasLimit,
      signMode,
    );
    return [
      (await import("./protobuf_stuff/cosmos/tx/v1beta1/tx")).TxRaw.fromPartial(
        {
          bodyBytes: txBodyBytes,
          authInfoBytes: signedAuthInfoBytes,
          signatures: [fromBase64(signature.signature)],
        },
      ),
      encryptionNonces,
    ];
  }

  private async encodeTx(txBody: {
    typeUrl: string;
    value: {
      messages: ProtoMsg[];
      memo: string;
    };
  }): Promise<Uint8Array> {
    const { Any } = await import("./protobuf_stuff/google/protobuf/any");

    const wrappedMessages = await Promise.all(
      txBody.value.messages.map(async (message) => {
        const binaryValue = await message.encode();
        return Any.fromPartial({
          typeUrl: message.typeUrl,
          value: binaryValue,
        });
      }),
    );

    const { TxBody } = await import("./protobuf_stuff/cosmos/tx/v1beta1/tx");

    const txBodyEncoded = TxBody.fromPartial({
      ...txBody.value,
      messages: wrappedMessages,
    });
    return TxBody.encode(txBodyEncoded).finish();
  }

  private async signDirect(
    signerAddress: string,
    messages: Msg[],
    fee: StdFee,
    memo: string,
    { accountNumber, sequence, chainId }: SignerData,
  ): Promise<
    [import("./protobuf_stuff/cosmos/tx/v1beta1/tx").TxRaw, ComputeMsgToNonce]
  > {
    if (!isOfflineDirectSigner(this.signer)) {
      throw new Error("Wrong signer type! Expected DirectSigner.");
    }

    const accountFromSigner = (await this.signer.getAccounts()).find(
      (account) => account.address === signerAddress,
    );
    if (!accountFromSigner) {
      throw new Error("Failed to retrieve account from signer");
    }

    const encryptionNonces: ComputeMsgToNonce = {};
    const txBody = {
      typeUrl: "/cosmos.tx.v1beta1.TxBody",
      value: {
        messages: await Promise.all(
          messages.map(async (msg, index) => {
            const asProto = await msg.toProto(this.encryptionUtils);
            if (
              asProto.typeUrl ===
              "/secret.compute.v1beta1.MsgInstantiateContract"
            ) {
              encryptionNonces[index] = asProto.value.initMsg.slice(0, 32);
            }
            if (
              asProto.typeUrl === "/secret.compute.v1beta1.MsgExecuteContract"
            ) {
              encryptionNonces[index] = asProto.value.msg.slice(0, 32);
            }

            return asProto;
          }),
        ),
        memo: memo,
      },
    };
    const txBodyBytes = await this.encodeTx(txBody);
    const pubkey = await encodePubkey(
      encodeSecp256k1Pubkey(accountFromSigner.pubkey),
    );
    const gasLimit = Number(fee.gas);
    const authInfoBytes = await makeAuthInfoBytes(
      [{ pubkey, sequence }],
      fee.amount,
      gasLimit,
    );
    const signDoc = makeSignDocProto(
      txBodyBytes,
      authInfoBytes,
      chainId,
      accountNumber,
    );
    const { signature, signed } = await this.signer.signDirect(
      signerAddress,
      signDoc,
    );
    return [
      (await import("./protobuf_stuff/cosmos/tx/v1beta1/tx")).TxRaw.fromPartial(
        {
          bodyBytes: signed.bodyBytes,
          authInfoBytes: signed.authInfoBytes,
          signatures: [fromBase64(signature.signature)],
        },
      ),
      encryptionNonces,
    ];
  }
}

function sleep(ms: number) {
  return new Promise((accept, reject) => setTimeout(accept, ms));
}

export function gasToFee(gasLimit: number, gasPrice: number): number {
  return Math.floor(gasLimit * gasPrice) + 1;
}

/**
 * Creates and serializes an AuthInfo document.
 *
 * This implementation does not support different signing modes for the different signers.
 */
async function makeAuthInfoBytes(
  signers: ReadonlyArray<{
    readonly pubkey: import("./protobuf_stuff/google/protobuf/any").Any;
    readonly sequence: number;
  }>,
  feeAmount: readonly Coin[],
  gasLimit: number,
  signMode?: import("./protobuf_stuff/cosmos/tx/signing/v1beta1/signing").SignMode,
): Promise<Uint8Array> {
  if (!signMode) {
    signMode = (
      await import("./protobuf_stuff/cosmos/tx/signing/v1beta1/signing")
    ).SignMode.SIGN_MODE_DIRECT;
  }

  const authInfo = {
    signerInfos: makeSignerInfos(signers, signMode),
    fee: {
      amount: [...feeAmount],
      gasLimit: String(gasLimit),
    },
  };

  const { AuthInfo } = await import("./protobuf_stuff/cosmos/tx/v1beta1/tx");
  return AuthInfo.encode(AuthInfo.fromPartial(authInfo)).finish();
}

/**
 * Create signer infos from the provided signers.
 *
 * This implementation does not support different signing modes for the different signers.
 */
function makeSignerInfos(
  signers: ReadonlyArray<{
    readonly pubkey: import("./protobuf_stuff/google/protobuf/any").Any;
    readonly sequence: number;
  }>,
  signMode: import("./protobuf_stuff/cosmos/tx/signing/v1beta1/signing").SignMode,
): import("./protobuf_stuff/cosmos/tx/v1beta1/tx").SignerInfo[] {
  return signers.map(
    ({
      pubkey,
      sequence,
    }): import("./protobuf_stuff/cosmos/tx/v1beta1/tx").SignerInfo => ({
      publicKey: pubkey,
      modeInfo: {
        single: { mode: signMode },
      },
      sequence: String(sequence),
    }),
  );
}

function makeSignDocProto(
  bodyBytes: Uint8Array,
  authInfoBytes: Uint8Array,
  chainId: string,
  accountNumber: number,
): import("./protobuf_stuff/cosmos/tx/v1beta1/tx").SignDoc {
  return {
    bodyBytes: bodyBytes,
    authInfoBytes: authInfoBytes,
    chainId: chainId,
    accountNumber: String(accountNumber),
  };
}

async function encodePubkey(
  pubkey: Pubkey,
): Promise<import("./protobuf_stuff/google/protobuf/any").Any> {
  const { Any } = await import("./protobuf_stuff/google/protobuf/any");

  if (isSecp256k1Pubkey(pubkey)) {
    const { PubKey } = await import(
      "./protobuf_stuff/cosmos/crypto/secp256k1/keys"
    );

    const pubkeyProto = PubKey.fromPartial({
      key: fromBase64(pubkey.value),
    });
    return Any.fromPartial({
      typeUrl: "/cosmos.crypto.secp256k1.PubKey",
      value: Uint8Array.from(PubKey.encode(pubkeyProto).finish()),
    });
  } else if (isMultisigThresholdPubkey(pubkey)) {
    const { LegacyAminoPubKey } = await import(
      "./protobuf_stuff/cosmos/crypto/multisig/keys"
    );

    const pubkeyProto = LegacyAminoPubKey.fromPartial({
      threshold: Number(pubkey.value.threshold),
      publicKeys: pubkey.value.pubkeys.map(encodePubkey),
    });
    return Any.fromPartial({
      typeUrl: "/cosmos.crypto.multisig.LegacyAminoPubKey",
      value: Uint8Array.from(LegacyAminoPubKey.encode(pubkeyProto).finish()),
    });
  } else {
    throw new Error(`Pubkey type ${pubkey.type} not recognized`);
  }
}

function isSecp256k1Pubkey(pubkey: Pubkey): boolean {
  return pubkey.type === "tendermint/PubKeySecp256k1";
}

function isMultisigThresholdPubkey(pubkey: Pubkey): boolean {
  return pubkey.type === "tendermint/PubKeyMultisigThreshold";
}

function makeSignDocAmino(
  msgs: readonly AminoMsg[],
  fee: StdFee,
  chainId: string,
  memo: string | undefined,
  accountNumber: number | string,
  sequence: number | string,
): StdSignDoc {
  return {
    chain_id: chainId,
    account_number: String(accountNumber),
    sequence: String(sequence),
    fee: fee,
    msgs: msgs,
    memo: memo || "",
  };
}
