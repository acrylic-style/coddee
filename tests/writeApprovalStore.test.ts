import { describe, expect, it } from "vitest";
import { VoiceWriteApprovalStore } from "../src/voice/writeApprovalStore.js";

describe("VoiceWriteApprovalStore", () => {
  const proposal = {
    userId: "user-1",
    guildId: "guild-1",
    channelId: "channel-1",
    sessionKey: "voice:guild-1:channel-1:user-1",
    prompt: "ファイルを更新して",
  };

  it("allows the requesting user to consume a proposal only once", () => {
    const store = new VoiceWriteApprovalStore();
    const created = store.create(proposal, 1_000);

    expect(store.take(created.id, "user-1", 2_000)).toEqual(created);
    expect(store.take(created.id, "user-1", 2_001)).toBeNull();
  });

  it("does not allow another user to approve a proposal", () => {
    const store = new VoiceWriteApprovalStore();
    const created = store.create(proposal, 1_000);

    expect(store.take(created.id, "user-2", 2_000)).toBeNull();
    expect(store.take(created.id, "user-1", 2_001)).toEqual(created);
  });

  it("expires proposals", () => {
    const store = new VoiceWriteApprovalStore(1_000);
    const created = store.create(proposal, 1_000);

    expect(store.take(created.id, "user-1", 2_000)).toBeNull();
  });
});
