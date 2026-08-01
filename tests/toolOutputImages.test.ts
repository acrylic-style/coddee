import { describe, expect, it } from "vitest";
import { extractToolOutputImages } from "../src/toolOutputImages.js";

function mcpItem(content: unknown[]): unknown {
  return {
    type: "mcp_tool_call",
    result: {
      content,
    },
  };
}

describe("extractToolOutputImages", () => {
  it("extracts MCP image blocks into Discord-ready buffers", () => {
    const result = extractToolOutputImages(
      [
        mcpItem([
          {
            type: "image",
            data: Buffer.from("png-content").toString("base64"),
            mimeType: "image/png",
          },
        ]),
      ],
      true,
    );

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.name).toBe("codex-image-1.png");
    expect(result.attachments[0]?.data.toString()).toBe("png-content");
    expect(result.omittedCount).toBe(0);
  });

  it("supports data URL image blocks and removes duplicates", () => {
    const dataUrl = `data:image/jpeg;base64,${Buffer.from("jpeg-content").toString("base64")}`;
    const result = extractToolOutputImages(
      [
        mcpItem([
          { type: "input_image", image_url: dataUrl },
          { type: "image_url", image_url: { url: dataUrl } },
        ]),
      ],
      true,
    );

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.name).toBe("codex-image-1.jpg");
  });

  it("does not expose incidental tool images when attachment output is disabled", () => {
    const result = extractToolOutputImages(
      [
        mcpItem([
          {
            type: "image",
            data: Buffer.from("secret-screen").toString("base64"),
            mimeType: "image/png",
          },
        ]),
      ],
      false,
    );

    expect(result).toEqual({ attachments: [], omittedCount: 0 });
  });

  it("counts unsupported image formats as omitted", () => {
    const result = extractToolOutputImages(
      [
        mcpItem([
          {
            type: "image",
            data: Buffer.from("<svg />").toString("base64"),
            mimeType: "image/svg+xml",
          },
        ]),
      ],
      true,
    );

    expect(result.attachments).toHaveLength(0);
    expect(result.omittedCount).toBe(1);
  });
});
