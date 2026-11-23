export function createCloudflareAccessFetch(
  raw: string | undefined,
  accountId?: string,
  apiToken?: string,
) {
  const tokens = new Map<string, [string, string]>();
  try {
    const config = JSON.parse(raw?.trim() || "{}");
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new Error();
    for (const [host, pair] of Object.entries(config)) {
      const name = host.toLowerCase();
      if (
        !/^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/u.test(name) ||
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        !pair.every(
          (value) => typeof value === "string" && /^[!-~]+$/u.test(value),
        ) ||
        tokens.has(name)
      )
        throw new Error();
      tokens.set(name, [pair[0], pair[1]]);
    }
  } catch {
    throw new Error(
      "CF_SERVICE_TOKENS must map hostnames to [clientId, clientSecret]",
    );
  }
  return async (input: string): Promise<string> => {
    const url = new URL(input);
    const pair = tokens.get(url.hostname);
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      !pair
    ) {
      throw new Error("許可されたHTTPSホストを指定してください。");
    }
    const response = await fetch(url, {
      headers: {
        "CF-Access-Client-Id": pair[0],
        "CF-Access-Client-Secret": pair[1],
      },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`取得できませんでした (HTTP ${response.status})。`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const html = /^(?:text\/html|application\/xhtml\+xml)(?:[;\s]|$)/iu.test(
      contentType,
    );
    if (
      !html &&
      !/^(?:text\/|application\/(?:json|xml)(?:[;\s]|$))/iu.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      await response.body.cancel();
      throw new Error("テキスト形式の応答のみ取得できます。");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let output = "";
    let remaining = html ? 512 * 1024 + 1 : 8_192;
    try {
      while (remaining > 0) {
        const { value, done } = await reader.read();
        if (done) break;
        output += decoder.decode(value.subarray(0, remaining), {
          stream: true,
        });
        remaining -= value.length;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    output += decoder.decode();
    for (const credentials of tokens.values()) {
      for (const credential of credentials)
        output = output.replaceAll(credential, "[redacted]");
    }
    if (html) {
      if (remaining <= 0) throw new Error("HTMLが512 KiBを超えています。");
      if (!accountId || !/^[a-f0-9]{32}$/iu.test(accountId) || !apiToken) {
        throw new Error("Browser Runの設定が必要です。");
      }
      const conversion = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-run/markdown`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ html: output, rejectRequestPattern: [".*"] }),
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!conversion.ok) {
        await conversion.body?.cancel();
        throw new Error("Browser Runでの変換に失敗しました。");
      }
      const converted = await conversion.json();
      if (converted.success !== true || typeof converted.result !== "string") {
        throw new Error("Browser Runでの変換に失敗しました。");
      }
      let markdown: string = converted.result.replaceAll(
        apiToken,
        "[redacted]",
      );
      for (const credentials of tokens.values()) {
        for (const credential of credentials)
          markdown = markdown.replaceAll(credential, "[redacted]");
      }
      const bytes = Buffer.from(markdown);
      return bytes.length > 8_192
        ? new TextDecoder().decode(bytes.subarray(0, 8_192), { stream: true }) +
            "\n（先頭8 KiBのみ）"
        : markdown;
    }
    return output + (remaining <= 0 ? "\n（先頭8 KiBのみ）" : "");
  };
}
