import { describe, expect, it } from "vitest";
import {
  splitDiscordMessage,
  stripBotMention,
} from "../src/discordMessageUtils.js";

describe("stripBotMention", () => {
  it("removes bot mentions from the content", () => {
    expect(stripBotMention("<@123> hello <@!123>", "123")).toBe("hello");
  });
});

describe("splitDiscordMessage", () => {
  it("returns one chunk for short strings", () => {
    expect(splitDiscordMessage("hello")).toEqual(["hello"]);
  });

  it("splits long strings into ordered chunks", () => {
    const text = "a".repeat(5000);
    const chunks = splitDiscordMessage(text, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });
});
