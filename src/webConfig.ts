export function loadWebConfig() {
  if (process.env.WEB_ENABLED !== "true") return;
  const host = process.env.WEB_HOST?.trim() || "127.0.0.1";
  const port = Number(process.env.WEB_PORT || 3000);
  const clientId = process.env.DISCORD_CLIENT_ID?.trim();
  const clientSecret = process.env.DISCORD_CLIENT_SECRET?.trim();
  const base = new URL(process.env.WEB_BASE_URL ?? "");
  if (
    !clientId ||
    !clientSecret ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    base.protocol !== "https:" ||
    base.pathname !== "/" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error(
      "Invalid web configuration. Set HTTPS WEB_BASE_URL, WEB_PORT, and Discord OAuth credentials.",
    );
  }
  return { host, port, baseUrl: base.origin, clientId, clientSecret };
}

export type WebConfig = NonNullable<ReturnType<typeof loadWebConfig>>;
