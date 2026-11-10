import {
  MEMBERFUL_CALLBACK_PATH,
  MEMBERFUL_WEBHOOK_PATH,
  memberfulSignInPath,
  WORDPRESS_CALLBACK_PATH,
  WORDPRESS_WEBHOOK_PATH,
  type Bootstrap,
  type Directory,
  type Me,
  type NewWorkspace,
  type UserId,
  type UserStatus,
  type WorkspaceSettings,
} from "@ember/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toHex } from "../src/encoding";
import type { Env } from "../src/env";
import { membershipApiOf } from "../src/membership-site";
import { api, apiWith, cookieOf, freshDeploy, origin, shown, withWorkspaceEnv, workspaceSql, type Session } from "./support";

// Signing in with a WordPress site in place of a Memberful one: the same flow, settings and checks as
// memberful.test.ts covers, through the WordPress site's plugin's protocol (docs/self-hosting.md).

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };

/** The WordPress site whose members sign in, and its plugin's keys, as the deployment's secrets give them. */
const SITE = "https://members.example.org";
const KEYS = { WORDPRESS_URL: `${SITE}/`, WORDPRESS_CLIENT_ID: "ember-client-id", WORDPRESS_CLIENT_SECRET: "ember-client-secret", WORDPRESS_SITE_NAME: "Example Club" };
const API_KEY = "ember-api-key";
const WEBHOOK_SECRET = "ember-webhook-secret";
const ALL_KEYS = { ...KEYS, WORDPRESS_API_KEY: API_KEY, WORDPRESS_WEBHOOK_SECRET: WEBHOOK_SECRET };
const CODE = "a-code-from-wordpress";
const ACCESS_TOKEN = "an-access-token";
const IP = "203.0.113.30";
const REDIRECT_URI = `${origin}${WORDPRESS_CALLBACK_PATH}`;

/** A member of the WordPress site as its member endpoint describes them. */
interface WordPressMember {
  id: string;
  email: string;
  full_name: string;
  active: boolean;
  level_ids: number[];
}

const ann: WordPressMember = { id: "123", email: "ann@example.com", full_name: "Ann Lee", active: true, level_ids: [1, 4] };

/** A request the fake WordPress site was sent. */
interface SentToWordPress {
  method: string;
  url: string;
  redirect: string;
  authorization: string | null;
  body: string;
}

/**
 * Stands in for the WordPress site's plugin: its token endpoint gives an access token for `CODE` sent
 * with the plugin's keys and the callback's address, its member endpoint describes `site.member` to that
 * token, and its memberships endpoint says whether `site.member` and `site.others` are active to the API
 * key, false for anyone else, leaving out the ids in `site.omitted`. What it's sent goes in `site.requests`.
 */
function fakeWordPress(member: Partial<WordPressMember> = {}) {
  const site = { member: { ...ann, ...member }, others: [] as WordPressMember[], omitted: [] as string[], requests: [] as SentToWordPress[] };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const body = new TextDecoder().decode(await request.arrayBuffer());
    const authorization = request.headers.get("Authorization");
    site.requests.push({ method: request.method, url: request.url, redirect: request.redirect, authorization, body });
    const url = new URL(request.url);
    if (request.method === "POST" && url.href === `${SITE}/wp-json/ember/v1/token`) {
      const form = new URLSearchParams(body);
      const valid =
        form.get("grant_type") === "authorization_code" &&
        form.get("code") === CODE &&
        form.get("client_id") === KEYS.WORDPRESS_CLIENT_ID &&
        form.get("client_secret") === KEYS.WORDPRESS_CLIENT_SECRET &&
        form.get("redirect_uri") === REDIRECT_URI;
      if (!valid) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: 600 });
    }
    if (request.method === "GET" && url.href === `${SITE}/wp-json/ember/v1/member` && authorization === `Bearer ${ACCESS_TOKEN}`) {
      return Response.json(site.member);
    }
    if (request.method === "POST" && url.href === `${SITE}/wp-json/ember/v1/memberships` && authorization === `Bearer ${API_KEY}`) {
      const { ids } = JSON.parse(body) as { ids: string[] };
      if (ids.length > 100) return Response.json({ error: "too_many" }, { status: 400 });
      const activeOf = (id: string) => [site.member, ...site.others].find((member) => member.id === id)?.active ?? false;
      return Response.json({ members: Object.fromEntries(ids.filter((id) => !site.omitted.includes(id)).map((id) => [id, activeOf(id)])) });
    }
    return new Response("Unauthorized", { status: 401 });
  });
  return site;
}

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});
const withKeys = (path: string, init: RequestInit<IncomingRequestCfProperties> = {}) => apiWith(KEYS, path, init);
const locationOf = (response: Response) => response.headers.get("Location");
const backToSignIn = (problem: string) => `${origin}/session/new?memberful=${problem}`;

/** Sets Ember up with Ada as its administrator, with the WordPress site on, members only unless `membersOnly` is false. */
async function setUpWithWordPress({ membersOnly = true } = {}): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  const administrator = { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
  const settings = { memberfulJoin: true, memberfulSignIn: membersOnly };
  const changed = await withKeys("/api/account", { method: "PATCH", headers: as(administrator), body: JSON.stringify({ settings }) });
  expect(changed.status, await changed.clone().text()).toBe(200);
  return administrator;
}

/** Starts signing in, answering where the browser is sent, the state, and the cookie that keeps it. */
async function start(): Promise<{ authorize: URL; state: string; cookie: string }> {
  const started = await withKeys(memberfulSignInPath(null));
  expect(started.status).toBe(302);
  const authorize = new URL(locationOf(started)!);
  return { authorize, state: authorize.searchParams.get("state")!, cookie: cookieOf(started) };
}

/** Where the WordPress site sends the browser back to, with `params`. */
const callback = (params: Record<string, string>, cookie: string, path = WORDPRESS_CALLBACK_PATH) =>
  withKeys(`${path}?${new URLSearchParams(params)}`, { headers: { "CF-Connecting-IP": IP, Cookie: cookie } });

/** Signs in with the WordPress site from a new browser, from start to the callback's answer. */
async function signInWithWordPress(): Promise<Response> {
  const { state, cookie } = await start();
  return callback({ code: CODE, state }, cookie);
}

async function signedInAs(response: Response): Promise<Me> {
  expect(response.status).toBe(302);
  const answer = await api("/api/me", { headers: { Cookie: cookieOf(response) } });
  expect(answer.status).toBe(200);
  return ((await answer.json()) as { user: Me }).user;
}

async function signatureOf(body: string, secret = WEBHOOK_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))));
}

/** The plugin's webhook with `payload`, signed as it signs one unless `signature` says otherwise (null for none), to `path`. */
async function webhook(payload: unknown, { signature, path = WORDPRESS_WEBHOOK_PATH }: { signature?: string | null; path?: string } = {}): Promise<Response> {
  const body = JSON.stringify(payload);
  const signed = signature === undefined ? await signatureOf(body) : signature;
  const headers = { "Content-Type": "application/json", ...(signed === null ? {} : { "X-Ember-Webhook-Signature": signed }) };
  return apiWith(ALL_KEYS, path, { method: "POST", headers, body });
}

const membershipChanged = (id: string) => ({ event: "membership.changed", member: { id } });
const hearingWebhooks = (run: () => Promise<void>) => () => withWorkspaceEnv(ALL_KEYS, run);
const queuedChecks = () => workspaceSql("SELECT issuer, subject FROM membership_checks ORDER BY subject");
const checked = () => vi.waitFor(async () => expect(await queuedChecks()).toEqual([]), { timeout: 5_000 });

async function statusOf(viewer: Session, id: UserId): Promise<UserStatus | undefined> {
  const { users } = (await (await api("/api/users", { headers: as(viewer) })).json()) as Directory;
  return users.find((user) => user.id === id)?.status;
}

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

describe("Sign in with WordPress", () => {
  it("is the deployment's membership site once WORDPRESS_URL is set, called by WORDPRESS_SITE_NAME, else WordPress", async () => {
    const providerWith = async (keys: Partial<Env>) => ((await (await apiWith(keys, "/api/bootstrap")).json()) as Bootstrap).membershipProvider;
    expect(await providerWith({})).toEqual({ kind: "memberful", name: "Memberful" });
    expect(await providerWith(KEYS)).toEqual({ kind: "wordpress", name: "Example Club" });
    expect(await providerWith({ ...KEYS, WORDPRESS_SITE_NAME: " " })).toEqual({ kind: "wordpress", name: "WordPress" });
  });

  it("can't be turned on without the plugin's keys, saying so by the site's name", async () => {
    const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
    const administrator = { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
    const refused = await apiWith({ ...KEYS, WORDPRESS_CLIENT_SECRET: undefined }, "/api/account", {
      method: "PATCH",
      headers: as(administrator),
      body: JSON.stringify({ settings: { memberfulJoin: true } }),
    });
    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain("Example Club needs WORDPRESS_URL, WORDPRESS_CLIENT_ID and WORDPRESS_CLIENT_SECRET set first");
  });

  it("sends the browser to the site's authorize page with the callback's address, and signs in someone new linked by the site's origin", async () => {
    await setUpWithWordPress();
    const site = fakeWordPress();
    const { authorize, state, cookie } = await start();
    expect(authorize.origin + authorize.pathname).toBe(`${SITE}/`);
    expect(Object.fromEntries(authorize.searchParams)).toEqual({
      ember_authorize: "1",
      response_type: "code",
      client_id: KEYS.WORDPRESS_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state,
    });

    const response = await callback({ code: CODE, state }, cookie);
    expect(locationOf(response)).toBe(`${origin}/`);
    const user = await signedInAs(response);
    expect(user).toEqual({ id: expect.any(String), name: "Ann Lee", administrator: false });
    expect(await workspaceSql("SELECT issuer, subject, user_id FROM identities")).toEqual([{ issuer: SITE, subject: "123", user_id: user.id }]);
    expect(site.requests.map(({ method, url, redirect }) => [method, new URL(url).pathname, redirect])).toEqual([
      ["POST", "/wp-json/ember/v1/token", "manual"],
      ["GET", "/wp-json/ember/v1/member", "manual"],
    ]);
    expect(site.requests[1]!.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(await signedInAs(await signInWithWordPress())).toEqual(user);
  });

  it("turns away someone the site denies, or whose membership isn't active, and answers only at its own callback", async () => {
    await setUpWithWordPress();
    const site = fakeWordPress({ active: false });
    expect(locationOf(await signInWithWordPress())).toBe(backToSignIn("membership"));

    const denied = await start();
    expect(locationOf(await callback({ error: "access_denied", state: denied.state }, denied.cookie))).toBe(backToSignIn("membership"));
    const failed = await start();
    expect(locationOf(await callback({ error: "server_error", state: failed.state }, failed.cookie))).toBe(backToSignIn("failed"));

    const elsewhere = await start();
    expect((await callback({ code: CODE, state: elsewhere.state }, elsewhere.cookie, MEMBERFUL_CALLBACK_PATH)).status).toBe(404);
    expect(site.requests.filter(({ url }) => url.endsWith("/token"))).toHaveLength(1);
    expect(await workspaceSql("SELECT count(*) AS n FROM identities")).toEqual([{ n: 0 }]);
  });

  it("says why joining is refused while it's members only in the site's terms", async () => {
    await setUpWithWordPress();
    const { join_code } = ((await workspaceSql("SELECT join_code FROM accounts")) as Array<{ join_code: string }>)[0]!;
    const response = await withKeys(`/api/join/${join_code}`, { method: "POST", body: JSON.stringify(ada) });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "Members sign in with Example Club. Only administrators and invited people sign in with a password." });
  });
});

describe("WordPress memberships", () => {
  it(
    "are checked with the memberships endpoint once a signed webhook says one changed, suspending a lapsed member",
    hearingWebhooks(async () => {
      const administrator = await setUpWithWordPress();
      const site = fakeWordPress();
      const { id } = await signedInAs(await signInWithWordPress());
      const settings = (await (await apiWith(ALL_KEYS, "/api/account", { headers: as(administrator) })).json()) as WorkspaceSettings;
      expect(settings).toMatchObject({ memberfulSite: SITE, memberfulWebhooks: true });

      const payload = membershipChanged(ann.id);
      for (const signature of [null, "00".repeat(32), await signatureOf(JSON.stringify(payload), "another secret")]) {
        expect((await webhook(payload, { signature })).status).toBe(401);
      }
      expect((await webhook(payload, { path: MEMBERFUL_WEBHOOK_PATH })).status).toBe(404);
      expect(await queuedChecks()).toEqual([]);

      site.member = { ...ann, active: false };
      expect((await webhook(payload)).status).toBe(204);
      await checked();
      expect(await statusOf(administrator, id)).toBe("suspended");
      const asked = site.requests.filter(({ url }) => url.endsWith("/memberships"));
      expect(asked.length).toBeGreaterThan(0);
      expect(asked[0]!.authorization).toBe(`Bearer ${API_KEY}`);
      expect(JSON.parse(asked[0]!.body)).toEqual({ ids: [ann.id] });

      site.member = ann;
      expect((await webhook({ event: "membership.changed", member: { id: Number(ann.id) } })).status).toBe(204);
      await checked();
      expect(await statusOf(administrator, id)).toBe("active");
    }),
  );

  it("are asked after at most 100 at a time, and an answer that leaves anyone out is no answer", async () => {
    const site = fakeWordPress();
    const api = membershipApiOf(ALL_KEYS as unknown as Env)!;
    const ids = Array.from({ length: 150 }, (_, i) => String(1000 + i));
    site.others = [{ ...ann, id: "1001" }];
    const memberships = await api.provider.membershipsOf(api, ids);
    expect(memberships?.size).toBe(150);
    expect(memberships?.get("1001")).toBe(true);
    expect(memberships?.get("1002")).toBe(false);
    expect(site.requests.map(({ body }) => (JSON.parse(body) as { ids: string[] }).ids.length)).toEqual([100, 50]);

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    site.omitted = ["1149"];
    expect(await api.provider.membershipsOf(api, ids)).toBeNull();
    expect(errors).toHaveBeenCalledWith("WordPress's memberships endpoint answered 200 without what it should");
  });
});
