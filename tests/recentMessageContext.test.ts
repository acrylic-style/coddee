import { describe, expect, it } from "vitest";
import { prependContextToInput } from "../src/recentMessageContext.js";

describe("prependContextToInput", () => {
  it("prepends context to plain text input", () => {
    const result = prependContextToInput("hello", "recent context");
    expect(result).toBe("recent context\n\nCurrent user request:\nhello");
  });

  it("prepends context to the first text block when images are present", () => {
    const result = prependContextToInput(
      [
        { type: "text", text: "describe this" },
        { type: "local_image", path: "/tmp/image.png" },
      ],
      "recent context",
    );

    expect(result).toEqual([
      {
        type: "text",
        text: "recent context\n\nCurrent user request:\ndescribe this",
      },
      { type: "local_image", path: "/tmp/image.png" },
    ]);
  });
});
