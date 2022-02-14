import { AminoMsg, Coin, Input, Msg, Output, ProtoMsg } from "./types";

export type MsgSendParams = {
  fromAddress: string;
  toAddress: string;
  amount: Coin[];
};

export class MsgSend implements Msg {
  public fromAddress: string;
  public toAddress: string;
  public amount: Coin[];

  constructor({ fromAddress, toAddress, amount }: MsgSendParams) {
    this.fromAddress = fromAddress;
    this.toAddress = toAddress;
    this.amount = amount;
  }

  async toProto(): Promise<ProtoMsg> {
    const msgContent = {
      fromAddress: this.fromAddress,
      toAddress: this.toAddress,
      amount: this.amount,
    };

    return {
      typeUrl: "/cosmos.bank.v1beta1.MsgSend",
      value: msgContent,
      encode: async () =>
        (
          await import("../protobuf_stuff/cosmos/bank/v1beta1/tx")
        ).MsgSend.encode(msgContent).finish(),
    };
  }

  async toAmino(): Promise<AminoMsg> {
    return {
      type: "cosmos-sdk/MsgSend",
      value: {
        from_address: this.fromAddress,
        to_address: this.toAddress,
        amount: this.amount,
      },
    };
  }
}

export type MsgMultiSendParams = {
  inputs: Input[];
  outputs: Output[];
};

export class MsgMultiSend implements Msg {
  public inputs: Input[];
  public outputs: Output[];

  constructor({ inputs, outputs }: MsgMultiSendParams) {
    this.inputs = inputs;
    this.outputs = outputs;
  }

  async toProto(): Promise<ProtoMsg> {
    const msgContent = {
      inputs: this.inputs,
      outputs: this.outputs,
    };

    return {
      typeUrl: "/cosmos.bank.v1beta1.MsgMultiSend",
      value: msgContent,
      encode: async () =>
        (
          await import("../protobuf_stuff/cosmos/bank/v1beta1/tx")
        ).MsgMultiSend.encode(msgContent).finish(),
    };
  }

  async toAmino(): Promise<AminoMsg> {
    return {
      type: "cosmos-sdk/MsgMultiSend",
      value: {
        inputs: this.inputs,
        outputs: this.outputs,
      },
    };
  }
}
