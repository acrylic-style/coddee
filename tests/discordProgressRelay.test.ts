import type { Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { DiscordProgressRelay } from "../src/discordProgressRelay.js";

describe("DiscordProgressRelay", () => {
  it("creates one progress reply and replaces it with the final response", async () => {
    const edit = vi.fn().mockResolvedValue(undefined);
    const sendInitial = vi
      .fn()
      .mockResolvedValue({ edit } as unknown as Message);
    const relay = new DiscordProgressRelay(sendInitial, 1_500);

    await relay.publish("調査していますわ…");
    await expect(relay.complete("完了しましたわ。")).resolves.toBe(true);

    expect(sendInitial).toHaveBeenCalledOnce();
    expect(sendInitial).toHaveBeenCalledWith("調査していますわ…");
    expect(edit).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledWith("完了しましたわ。");
  });

  it("does not create a message when no progress was published", async () => {
    const sendInitial = vi.fn();
    const relay = new DiscordProgressRelay(sendInitial, 1_500);

    await expect(relay.complete("完了しましたわ。")).resolves.toBe(false);
    expect(sendInitial).not.toHaveBeenCalled();
  });

  it("coalesces rapid progress updates", async () => {
    vi.useFakeTimers();
    const edit = vi.fn().mockResolvedValue(undefined);
    const sendInitial = vi
      .fn()
      .mockResolvedValue({ edit } as unknown as Message);
    const relay = new DiscordProgressRelay(sendInitial, 1_500);

    await relay.publish("調査中ですわ…");
    await relay.publish("編集中ですわ…");
    await relay.publish("確認中ですわ…");
    await vi.advanceTimersByTimeAsync(1_500);

    expect(edit).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledWith("確認中ですわ…");
    vi.useRealTimers();
  });
});
