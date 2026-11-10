import {
  MEMBERFUL_CONNECTED,
  MEMBERFUL_PROBLEM_PARAM,
  workspacePageOf,
  type AccountSettings,
  type MemberfulConnection,
  type MemberfulSignInProblem,
  type UserId,
} from "@ember/protocol";
import { authenticate, clientOf, cookieValues, hostCookie, hostCookieName, newSessionToken, sessionCookie, tokenDigest } from "./auth";
import { bytesUpTo, MAX_JSON_BODY_BYTES } from "./bodies";
import { originFor } from "./custom-domain";
import { fromHex, toBase64url, urlsafeDecode64 } from "./encoding";
import type { Env } from "./env";
import { notFound } from "./error-pages";
import type { MemberfulApi, MemberfulKeys } from "./memberful-api";
import { membershipApiOf, membershipKeysOf, providerOf } from "./membership-site";
import { home, withCookies } from "./pages";
import { urlOf } from "./request-url";
import { isToken } from "./secrets";
import { MEMBERFUL_ROUND_TRIP_MS, workspace } from "./workspace";

// Signing in with Memberful. Memberful speaks OAuth 2.0 but not OpenID Connect, so this follows its
// guide for a server-side custom app (memberful.com/docs/api-reference/sign-in-for-apps-via-oauth): Sign
// in with Memberful sends the browser to the site's `/oauth` with a random state, which a cookie keeps,
// and the site sends it back to the callback with that state and a code, which the Worker exchanges,
// with the app's client secret, for an access token to ask the member API who signed in. It works only
// while the deployment has the app's keys, and lets someone new in only while an administrator has
// Memberful on, but signs in the members who joined with it once it's off too, since they have no
// password. While it's members only, someone who has an account here already connects their Memberful
// account to it the same way, once their password has checked out, from their profile, or as they sign
// in: the Workspace keeps the state's digest for the callback, which connects the account to theirs.
// A deployment whose members sign in with a WordPress site instead (membership-site.ts) goes the same
// way, by its own callback and webhook paths, sending it the callback's address as `redirect_uri`.

/** The cookie that keeps a sign-in's state, and the page to come back to, until Memberful sends the browser back. */
const STATE_COOKIE = "memberful_state";
/** How long that takes at most: long enough to sign in at Memberful, or sign up there. */
const STATE_MAX_AGE_SECONDS = MEMBERFUL_ROUND_TRIP_MS / 1000;
/** The longest page to come back to that the cookie keeps. Any longer, and signing in goes home. */
const MAX_RETURN_PATH_LENGTH = 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** Why Memberful can't be turned on: the deployment lacks the keys of a Memberful site's custom app. */
export const MEMBERFUL_KEYS_NEEDED = "Memberful needs MEMBERFUL_URL, MEMBERFUL_CLIENT_ID and MEMBERFUL_CLIENT_SECRET set first";

/** Why `settings` can't be saved with the keys the deployment has: turning Memberful, or its Members only, on takes them all. Null when they can. */
export const memberfulRefusal = (settings: AccountSettings | undefined, env: Env) =>
  (settings?.memberfulJoin || settings?.memberfulSignIn) && !membershipKeysOf(env) ? keysNeeded(env) : null;

/** Why the deployment's membership site can't be turned on without its keys. */
function keysNeeded(env: Env): string {
  const { kind, name } = providerOf(env);
  return kind === "wordpress" ? `${name} needs WORDPRESS_URL, WORDPRESS_CLIENT_ID and WORDPRESS_CLIENT_SECRET set first` : MEMBERFUL_KEYS_NEEDED;
}

/** A redirect to `location`, which no cache keeps, since it signs someone in, or starts to. */
const redirect = (location: string, ...cookies: string[]) =>
  withCookies(new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } }), ...cookies);

/** Sends the browser back to sign in, which says why signing in with Memberful didn't work. */
const backToSignIn = (request: Request, problem: MemberfulSignInProblem) =>
  redirect(new URL(`/session/new?${MEMBERFUL_PROBLEM_PARAM}=${problem}`, request.url).href);

/** Sends the browser back to `returnPath`, a page of the workspace, which says how connecting Memberful went: `outcome`. */
function backTo(request: Request, returnPath: string, outcome: MemberfulSignInProblem | typeof MEMBERFUL_CONNECTED): Response {
  const url = new URL(returnPath, request.url);
  url.searchParams.set(MEMBERFUL_PROBLEM_PARAM, outcome);
  return redirect(url.href);
}

/** Where to sign in at the membership site, which sends the browser back to the callback at `origin`, Ember's, with `state`. */
const authorizationOf = (keys: MemberfulKeys, state: string, origin: string) => keys.provider.authorizationOf(keys, state, callbackOf(keys, origin));

/** The callback's address at `origin`, which the membership site sends the browser back to. */
const callbackOf = (keys: MemberfulKeys, origin: string) => new URL(keys.provider.callbackPath, origin).href;

/**
 * The page of the workspace at `origin` that `returnTo` names, its query and fragment included, or "/"
 * for anything else, so that signing in only ever opens a page here, or for one too long to keep, as
 * its address writes it, with every character that isn't ASCII escaped.
 */
function returnPathOf(returnTo: string | null, origin: string): string {
  const url = returnTo === null ? null : URL.parse(returnTo, origin);
  const path = url?.origin === origin && workspacePageOf(url.pathname) ? `${url.pathname}${url.search}${url.hash}` : "/";
  return path.length <= MAX_RETURN_PATH_LENGTH ? path : "/";
}

/** What the state cookie of a connection ends with, after the page to come back to. */
const CONNECTING = "connecting";

/**
 * The `Set-Cookie` that keeps a sign-in's `state` and the page to come back to, `returnPath`, and whether
 * it's `connecting` an account, so that the callback never takes one whose connection has gone for a
 * sign-in.
 */
const stateCookie = (request: Request, state: string, returnPath: string, connecting = false) =>
  hostCookie(request, STATE_COOKIE, `${state}.${toBase64url(encoder.encode(returnPath))}${connecting ? `.${CONNECTING}` : ""}`, STATE_MAX_AGE_SECONDS);

/** The `Set-Cookie` that forgets it. */
const expiredStateCookie = (request: Request) => hostCookie(request, STATE_COOKIE, "", 0);

/** The state, the page to come back to, and whether it's connecting an account, that the request's cookie keeps, if it keeps any. */
function keptStateOf(request: Request): { state: string; returnPath: string; connecting: boolean } | null {
  const [kept] = cookieValues(request, hostCookieName(request, STATE_COOKIE));
  const [state, encoded, connecting] = kept?.split(".") ?? [];
  const bytes = encoded === undefined ? null : urlsafeDecode64(encoded);
  if (!state || !bytes) return null;
  try {
    return { state, returnPath: returnPathOf(decoder.decode(bytes), urlOf(request).origin), connecting: connecting === CONNECTING };
  } catch {
    return null;
  }
}

/**
 * `GET /auth/memberful`, Sign in with Memberful: sends the browser to sign in at the Memberful site,
 * keeping a new state and the page `return_to` names in a cookie, to come back to Ember's address, its
 * custom domain if it has one, where Memberful sends the browser back. Before first run it goes home,
 * and while it isn't offered (`Workspace.offersMemberfulSignIn`), back to sign in, which says Memberful
 * is off, or isn't set up while it's on without the deployment's keys.
 */
export async function startMemberfulSignIn(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return notFound(request);
  const account = await workspace(env).account();
  if (!account) return home(request);
  const keys = membershipKeysOf(env);
  if (!keys) return backToSignIn(request, account.memberfulJoin ? "unavailable" : "off");
  if (!(await workspace(env).offersMemberfulSignIn(keys.site))) return backToSignIn(request, "off");
  const url = urlOf(request);
  // The cookie is only sent back to the address that set it.
  const origin = originFor(request, account.customDomain);
  if (origin !== url.origin) return redirect(new URL(`${url.pathname}${url.search}`, origin).href);
  const state = newSessionToken();
  return redirect(authorizationOf(keys, state, origin), stateCookie(request, state, returnPathOf(url.searchParams.get("return_to"), origin)));
}

/**
 * Starts connecting the account of `userId`, whose password's digest `passwordDigest` the Worker checked
 * the password they gave against, or "" without one, to an account at the Memberful site, to come back
 * to the page `returnTo` names: where to sign in there, and the `Set-Cookie` that keeps the state it
 * goes with, whose digest the Workspace keeps for the callback. Null unless the deployment has
 * Memberful's keys and the Workspace kept it (`startMemberfulConnection`). Asked at an address Ember has
 * moved from to its custom domain, as a tab left open there is, it starts nothing, and answers that page
 * at the custom domain instead, to sign in and connect there.
 */
export async function memberfulConnectionFor(
  request: Request,
  env: Env,
  userId: UserId,
  passwordDigest: string,
  returnTo: unknown,
): Promise<{ connection: MemberfulConnection; cookie: string | null } | null> {
  const keys = membershipKeysOf(env);
  if (!keys) return null;
  const url = urlOf(request);
  const returnPath = returnPathOf(typeof returnTo === "string" ? returnTo : null, url.origin);
  // Memberful sends the browser back to the custom domain, which a cookie kept here is never sent to.
  const origin = originFor(request, (await workspace(env).account())?.customDomain ?? null);
  if (origin !== url.origin) return { connection: { memberfulConnection: new URL(returnPath, origin).href }, cookie: null };
  const state = newSessionToken();
  if (!(await workspace(env).startMemberfulConnection(userId, passwordDigest, await tokenDigest(state, env.SESSION_SECRET), keys.site))) return null;
  return { connection: { memberfulConnection: authorizationOf(keys, state, origin) }, cookie: stateCookie(request, state, returnPath, true) };
}

/**
 * `GET /auth/memberful/callback`, where Memberful sends the browser back: signs it in as whoever signed
 * in there (`Workspace.signInWithMemberful`), or connects their account there to the one here that the
 * state started connecting (`Workspace.connectMemberful`), and opens the page it was started from, or
 * else goes back to sign in, or to that page when the browser is signed in, which says why not. Each
 * state is good for one try, whatever comes of it.
 */
export async function finishMemberfulSignIn(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" || urlOf(request).pathname !== providerOf(env).callbackPath) return notFound(request);
  const answer = await signedInWithMemberful(request, env);
  answer.headers.append("Set-Cookie", expiredStateCookie(request));
  return answer;
}

async function signedInWithMemberful(request: Request, env: Env): Promise<Response> {
  const keys = membershipKeysOf(env);
  if (!keys) return backToSignIn(request, "unavailable");
  const params = urlOf(request).searchParams;
  const [kept, state, code] = [keptStateOf(request), params.get("state"), params.get("code")];
  // A state this browser didn't start with, as another site's link to the callback would bring, signs
  // nobody in and connects nothing, nor does a callback without a code.
  if (!kept || state === null || !(await isToken(state, kept.state))) return backToSignIn(request, "failed");
  if (!code) return backToSignIn(request, keys.provider.noMembershipError !== null && params.get("error") === keys.provider.noMembershipError ? "membership" : "failed");
  // Each try counts against the address's sign-in limit, before Memberful is asked anything.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const connection = kept.connecting ? await tokenDigest(kept.state, env.SESSION_SECRET) : null;
  const [begun, signedIn] = await Promise.all([workspace(env).beginMemberfulSignIn(ip, connection), authenticate(request, env)]);
  const back = (problem: MemberfulSignInProblem) => (signedIn ? backTo(request, kept.returnPath, problem) : backToSignIn(request, problem));
  if (begun === "limited") return back("refused");
  if (begun === "expired") return back("failed");
  const member = await keys.provider.memberWhoSignedIn(keys, code, callbackOf(keys, urlOf(request).origin));
  if (!member) return back("failed");
  const token = newSessionToken();
  const digest = await tokenDigest(token, env.SESSION_SECRET);
  const { connecting, begunAt } = begun;
  // A browser signed in as whoever is connecting stays signed in as it is.
  const staying = connecting !== null && signedIn?.user.id === connecting.userId;
  const user =
    connecting === null
      ? await workspace(env).signInWithMemberful(keys.site, member, begunAt, digest, clientOf(request))
      : await workspace(env).connectMemberful(keys.site, member, begunAt, connecting, staying ? null : digest, clientOf(request));
  if (user === "connected") return backTo(request, kept.returnPath, MEMBERFUL_CONNECTED);
  if (typeof user === "string") return back(user);
  return redirect(new URL(kept.returnPath, request.url).href, sessionCookie(request, token));
}

/**
 * `POST /webhooks/memberful`, where the Memberful site says a member's account, subscription or order
 * changed: once its signature checks out, the Workspace queues checking that member's membership with
 * the admin API, if they're linked to someone here, rather than trusting what it says, as Memberful
 * advises, since its webhooks can come in any order (memberful.com/docs/api-reference/webhooks). Answers
 * 404 without the webhook's secret and the API key to check with, 401 to a signature that doesn't check
 * out, 413 to a body over the limit, and 204 to anything else, which Memberful takes as delivered.
 */
export async function memberfulWebhook(request: Request, env: Env): Promise<Response> {
  const provider = providerOf(env);
  if (request.method !== "POST" || urlOf(request).pathname !== provider.webhookPath) return notFound(request);
  const webhooks = memberfulWebhooksOf(env);
  if (!webhooks) {
    console.error(`A ${provider.name} webhook came, but the deployment lacks ${provider.webhookSecretName} or ${provider.apiKeyName}, so it's refused`);
    return new Response(null, { status: 404 });
  }
  const body = await bytesUpTo(request, MAX_JSON_BODY_BYTES);
  if (body === null) return new Response(null, { status: 413 });
  if (!(await isSignedWith(webhooks.secret, body, request.headers.get(provider.signatureHeader)))) return new Response(null, { status: 401 });
  const subject = provider.subjectOf(parsed(body));
  if (subject !== null) await workspace(env).queueMembershipCheck(webhooks.api.site, subject);
  return new Response(null, { status: 204 });
}

/**
 * What hearing Memberful's webhooks takes, or null without it all: the deployment's Memberful site and
 * its custom app's API key, to check what one says with, and the secret Memberful signs them with.
 */
export function memberfulWebhooksOf(env: Env): { api: MemberfulApi; secret: string } | null {
  const api = membershipApiOf(env);
  const secret = api && env[api.provider.webhookSecretName]?.trim();
  return api && secret ? { api, secret } : null;
}

/** Whether `signature` is the hex HMAC-SHA256 of `body` under `secret`, compared in constant time. */
async function isSignedWith(secret: string, body: ArrayBuffer, signature: string | null): Promise<boolean> {
  const signed = signature === null ? null : fromHex(signature.trim().toLowerCase());
  if (signed?.byteLength !== 32) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, signed, body);
}

/** The JSON value `body` holds, or null for none. */
function parsed(body: ArrayBuffer): unknown {
  try {
    return JSON.parse(decoder.decode(body));
  } catch {
    return null;
  }
}
