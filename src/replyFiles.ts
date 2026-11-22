import { open, realpath } from "node:fs/promises";
import path from "node:path";

const limit = 8 * 1024 * 1024;
const reference =
  /\[([^\]\n]+)\]\(<?((?:[a-z]:[\\/]|\/(?!\/)|\.\.?[\\/])[^\n)>]+)>?\)|`((?:[a-z]:[\\/]|\/(?!\/)|\.\.?[\\/])[^\n`]+)`/giu;

function permitted(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    Boolean(relative) &&
    !path.isAbsolute(relative) &&
    relative
      .split(path.sep)
      .every(
        (part) =>
          !part.startsWith(".") &&
          !/(?:^|[._-])(?:credentials?|secrets?|passwords?|tokens?|id_rsa|id_ed25519)(?:[._-]|$)|\.(?:pem|key|pfx|p12|kdbx)$/iu.test(
            part,
          ) &&
          !part.includes(":"),
      )
  );
}

export async function attachReplyFiles(
  text: string,
  workdir: string,
  maxFiles = 5,
) {
  const files: { attachment: Buffer; name: string }[] = [];
  const matches = [...text.matchAll(reference)];
  if (!matches.length) return { text, files };
  const root = await realpath(workdir);
  const attached = new Map<string, string>();
  let remaining = limit;
  let offset = 0;
  let output = "";
  for (const match of matches) {
    output += text.slice(offset, match.index);
    offset = match.index + match[0].length;
    const raw = match[2] ?? match[3];
    let label = "ファイル";
    try {
      const decoded = decodeURIComponent(raw)
        .replace(/:\d+(?::\d+)?$/u, "")
        .replace(/^\/(?=[a-z]:[\\/])/iu, "");
      const candidate = path.resolve(root, decoded);
      label = path.basename(candidate).replace(/[`\r\n]/gu, "");
      if (!permitted(root, candidate)) throw new Error("添付対象外");
      const file = await realpath(candidate);
      if (!permitted(root, file)) throw new Error("添付対象外");
      if (!attached.has(file)) {
        if (files.length >= maxFiles) throw new Error("添付数の上限");
        const handle = await open(file, "r");
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) throw new Error("通常ファイルではありません");
          if (stat.size > remaining) throw new Error("添付容量の上限");
          const buffer = Buffer.alloc(stat.size + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead !== stat.size)
            throw new Error("ファイルが更新されました");
          const name = files.some((entry) => entry.name === label)
            ? `${files.length + 1}-${label}`
            : label;
          files.push({ attachment: buffer.subarray(0, bytesRead), name });
          remaining -= bytesRead;
          attached.set(file, name);
        } finally {
          await handle.close();
        }
      }
      output += `${attached.get(file)}（添付）`;
    } catch (error) {
      const reason = (error as NodeJS.ErrnoException).code
        ? "ファイルを読み込めませんでした"
        : error instanceof URIError
          ? "パスの形式が無効"
          : (error as Error).message;
      output += `${label}（添付不可・${reason}）`;
    }
  }
  return { text: output + text.slice(offset), files };
}
