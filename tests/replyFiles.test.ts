import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { attachReplyFiles } from "../src/replyFiles.js";

it("attaches original bytes once and blocks hidden or out-of-workspace references", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coddee-files-"));
  try {
    const content = Buffer.from([0, 255, 13, 10]);
    await writeFile(path.join(directory, "report data.bin"), content);
    await writeFile(path.join(directory, ".env"), "secret");
    const result = await attachReplyFiles(
      "[report](<./report data.bin:2>) and `./report data.bin` and `./.env` and `../outside.txt` and `./missing.txt`",
      directory,
    );
    expect(result.files).toEqual([
      { name: "report data.bin", attachment: content },
    ]);
    expect(result.text).toContain(
      `\` ${path.join(directory, ".env")} \`（添付不可・添付対象外）`,
    );
    expect(result.text).toContain(
      `\` ${path.resolve(directory, "../outside.txt")} \`（添付不可・添付対象外）`,
    );
    expect(result.text).toContain(
      `\` ${path.join(directory, "missing.txt")} \`（添付不可・ファイルを読み込めませんでした）`,
    );
    expect(result.text).not.toContain("./");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
