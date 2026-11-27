import { createHash, randomBytes } from "node:crypto";
import { ChannelType, PermissionFlagsBits, type Client } from "discord.js";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import { secureHeaders } from "hono/secure-headers";
import type { WebConfig } from "./webConfig.js";
import type { WebStore, WebTurn } from "./webStore.js";

const cookie = {
  path: "/",
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
} as const;
const sessionCookie = "__Host-coddee-session";
const loginCookie = "__Host-coddee-login";
const authOrigin = "https://discord.com";
const token = () => randomBytes(32).toString("base64url");

async function canView(client: Client, entry: WebTurn, userId: string) {
  if (!entry.guildId) return entry.authorId === userId;
  try {
    const channel = await client.channels.fetch(entry.channelId, {
      force: true,
    });
    if (!channel || channel.isDMBased() || channel.guild.id !== entry.guildId)
      return false;
    const [member] = await Promise.all([
      channel.guild.members.fetch({ user: userId, force: true }),
      channel.guild.roles.fetch(),
    ]);
    if (channel.isThread() && channel.parentId) {
      await client.channels.fetch(channel.parentId, { force: true });
    }
    const permissions = channel.permissionsFor(member);
    if (
      !permissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ])
    )
      return false;
    if (
      channel.type === ChannelType.PrivateThread &&
      !permissions.has(PermissionFlagsBits.ManageThreads)
    ) {
      await channel.members.fetch({ member: userId, force: true });
    }
    return true;
  } catch {
    return false;
  }
}

function page(title: string, content: ReturnType<typeof html>) {
  return html`<!doctype html>
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} | coddee</title>
        <style>
          body {
            font:
              16px/1.65 system-ui,
              sans-serif;
            margin: 0;
            background: #f5f7fb;
            color: #172033;
          }
          main {
            max-width: 52rem;
            margin: auto;
            padding: 2rem 1rem 4rem;
          }
          a {
            color: #294cb3;
          }
          header {
            display: flex;
            justify-content: space-between;
            gap: 1rem;
            align-items: center;
          }
          article,
          nav ul {
            background: #fff;
            border: 1px solid #dbe2ef;
            border-radius: 0.75rem;
            padding: 1rem 1.25rem;
            margin: 1rem 0;
          }
          nav ul {
            list-style: none;
          }
          small {
            color: #52607a;
          }
          p {
            white-space: pre-wrap;
            overflow-wrap: anywhere;
          }
          button {
            font: inherit;
            cursor: pointer;
          }
          h2 {
            font-size: 1.15rem;
          }
        </style>
      </head>
      <body>
        <main>
          <header><a href="/">coddee</a></header>
          <h1>${title}</h1>
          ${content}
        </main>
      </body>
    </html>`;
}

export function createWebApp(
  config: WebConfig,
  store: WebStore,
  client: Client,
) {
  const app = new Hono();
  const pending = new Map<string, { verifier: string; expiresAt: number }>();
  const sessions = new Map<string, { userId: string; expiresAt: number }>();
  const redirectUri = config.baseUrl + "/auth/callback";

  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        styleSrc: ["'unsafe-inline'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
      referrerPolicy: "no-referrer",
    }),
  );
  app.use(async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  app.onError((_error, c) =>
    c.text("Webリクエストを処理できませんでした。", 500),
  );

  app.get("/d/:id", async (c) => {
    const file = await store.download(c.req.param("id"));
    if (!file) return c.notFound();
    const name = encodeURIComponent(
      Buffer.from(file.name).toString("utf8"),
    ).replace(/['()*]/g, (char) => "%" + char.charCodeAt(0).toString(16));
    return new Response(file.stream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": "attachment; filename*=UTF-8''" + name,
      },
    });
  });

  app.get("/login", (c) => {
    const now = Date.now();
    for (const [key, item] of pending)
      if (item.expiresAt <= now) pending.delete(key);
    for (const [key, item] of sessions)
      if (item.expiresAt <= now) sessions.delete(key);
    if (pending.size >= 2048)
      return c.text("しばらく待ってから再試行してください。", 503);
    const state = token();
    const verifier = token();
    pending.set(state, { verifier, expiresAt: now + 300_000 });
    setCookie(c, loginCookie, state, { ...cookie, maxAge: 300 });
    const url = new URL("/oauth2/authorize", authOrigin);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "identify",
      state,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }).toString();
    return c.redirect(url.toString());
  });

  app.get("/auth/callback", async (c) => {
    const state = c.req.query("state");
    const code = c.req.query("code");
    const incoming = getCookie(c, loginCookie);
    deleteCookie(c, loginCookie, cookie);
    const login = state && state === incoming ? pending.get(state) : undefined;
    if (!state || !code || !login || login.expiresAt <= Date.now())
      return c.text("ログインをやり直してください。", 400);
    pending.delete(state);
    const issuer = c.req.query("iss");
    if (issuer && issuer !== authOrigin)
      return c.text("無効な認証元です。", 400);
    const response = await fetch(authOrigin + "/api/v10/oauth2/token", {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: login.verifier,
      }),
    });
    if (!response.ok) return c.text("Discord認証に失敗しました。", 401);
    const { access_token } = (await response.json()) as {
      access_token?: string;
    };
    if (!access_token) return c.text("Discord認証に失敗しました。", 401);
    const user = await fetch(authOrigin + "/api/v10/users/@me", {
      headers: { Authorization: "Bearer " + access_token },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!user.ok) return c.text("Discord認証に失敗しました。", 401);
    const { id } = (await user.json()) as { id: string };
    if (!/^\d{17,20}$/u.test(id))
      return c.text("Discord認証に失敗しました。", 401);
    const sessionId = token();
    const previous = getCookie(c, sessionCookie);
    if (previous) sessions.delete(previous);
    sessions.set(sessionId, { userId: id, expiresAt: Date.now() + 28_800_000 });
    setCookie(c, sessionCookie, sessionId, { ...cookie, maxAge: 28_800 });
    return c.redirect("/");
  });

  function signedIn(key?: string) {
    if (!key) return;
    const session = sessions.get(key);
    if (session && session.expiresAt > Date.now()) return session.userId;
    sessions.delete(key);
  }

  app.post("/logout", (c) => {
    if (c.req.header("origin") !== config.baseUrl)
      return c.text("Forbidden", 403);
    const key = getCookie(c, sessionCookie);
    if (key) sessions.delete(key);
    deleteCookie(c, sessionCookie, cookie);
    return c.redirect("/", 303);
  });

  app.get("/", async (c) => {
    const userId = signedIn(getCookie(c, sessionCookie));
    if (!userId)
      return c.html(
        page("会話履歴", html`<a href="/login">Discordでログイン</a>`),
      );
    const channels = new Map<string, WebTurn>();
    for (const entry of store.list())
      if (!channels.has(entry.channelId)) channels.set(entry.channelId, entry);
    const visible = [];
    for (const entry of channels.values()) {
      if (await canView(client, entry, userId)) visible.push(entry);
    }
    return c.html(
      page(
        "会話履歴",
        html` <form method="post" action="/logout">
            <button>ログアウト</button>
          </form>
          <nav>
            <ul>
              ${visible.length ? visible.map((entry) => html`<li><a href="/channels/${entry.channelId}">${entry.channelName}</a></li>`) : html`<li>表示できる会話はありません。</li>`}
            </ul>
          </nav>`,
      ),
    );
  });

  app.get("/channels/:id", async (c) => {
    const userId = signedIn(getCookie(c, sessionCookie));
    if (!userId) return c.redirect("/");
    const entries = store
      .list()
      .filter(
        (entry) =>
          entry.channelId === c.req.param("id") &&
          (entry.guildId || entry.authorId === userId),
      );
    if (!entries[0] || !(await canView(client, entries[0], userId)))
      return c.notFound();
    const cursor = c.req.query("before");
    const index = cursor
      ? entries.findIndex((entry) => entry.id === cursor) + 1
      : 0;
    if (cursor && !index) return c.notFound();
    const batch = entries.slice(index, index + 20);
    return c.html(
      page(
        entries[0].channelName,
        html`
          ${batch.map(
            (entry) =>
              html`<article>
                <small
                  >${entry.author} ·
                  ${new Date(entry.createdAt).toISOString()}</small
                >
                <h2>
                  <a href="/turns/${entry.id}"
                    >${entry.prompt.slice(0, 120) || "添付ファイルの依頼"}</a
                  >
                </h2>
                <p>${entry.summary || "要約なし"}</p>
              </article>`,
          )}
          ${entries.length > index + batch.length ? html`<a href="?before=${batch.at(-1)?.id}">以前の依頼</a>` : ""}
        `,
      ),
    );
  });

  app.get("/turns/:id", async (c) => {
    const userId = signedIn(getCookie(c, sessionCookie));
    if (!userId) return c.redirect("/");
    const entry = store.get(c.req.param("id"));
    if (!entry || !(await canView(client, entry, userId))) return c.notFound();
    return c.html(
      page(
        "依頼の詳細",
        html`
          <a href="/channels/${entry.channelId}">${entry.channelName}</a>
          <article>
            <small
              >${entry.author} ·
              ${new Date(entry.createdAt).toISOString()}</small
            >
            <h2>AI要約</h2>
            <p>${entry.summary || "要約なし"}</p>
            <h2>依頼</h2>
            <p>${entry.prompt}</p>
            <h2>回答</h2>
            <p>${entry.reply}</p>
            <a href="${entry.discordUrl}">Discordで開く</a>
          </article>
        `,
      ),
    );
  });
  return app;
}
