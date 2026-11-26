import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function codexCliPath(): string {
  const sdkRequire = createRequire(
    fileURLToPath(import.meta.resolve("@openai/codex-sdk")),
  );
  return path.join(
    path.dirname(sdkRequire.resolve("@openai/codex/package.json")),
    "bin",
    "codex.js",
  );
}
