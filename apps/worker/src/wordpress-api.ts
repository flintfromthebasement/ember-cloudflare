import { MAX_EMAIL_ADDRESS_LENGTH, WORDPRESS_CALLBACK_PATH, WORDPRESS_WEBHOOK_PATH } from "@ember/protocol";
import type { Env } from "./env";
import { isLoopback } from "./loopback";
import { cutName, namesOf, refused, subjectFrom, type MemberfulApi, type MemberfulKeys, type MemberfulMember, type ProviderApi } from "./memberful-api";

// What Ember asks a WordPress site whose members sign in, through a plugin that speaks Ember's sign-in
// (docs/self-hosting.md): its authorize page, where someone signed in to WordPress is sent back with a
// code, its token endpoint, which exchanges the code for an access token, its member endpoint, which
// says with that token who signed in, and its memberships endpoint, which says with the API key whose
// memberships are active. It's the same OAuth flow as Memberful's, and Ember goes by what it says as it
// does by Memberful. Nothing follows a redirect, which would take a secret elsewhere, and the site's
// answers are logged by their status alone.

/** How long the WordPress site has to answer each request. */
const WORDPRESS_TIMEOUT_MS = 10_000;
/** Where the plugin's REST API is. */
const API_PATH = "/wp-json/ember/v1";
/** The most members the memberships endpoint is asked after at once. */
const MEMBERS_PER_REQUEST = 100;

/** What pages call the WordPress site, without `WORDPRESS_SITE_NAME`. */
const DEFAULT_NAME = "WordPress";

const WORDPRESS: ProviderApi = {
  kind: "wordpress",
  name: DEFAULT_NAME,
  callbackPath: WORDPRESS_CALLBACK_PATH,
  webhookPath: WORDPRESS_WEBHOOK_PATH,
  signatureHeader: "X-Ember-Webhook-Signature",
  apiKeyName: "WORDPRESS_API_KEY",
  webhookSecretName: "WORDPRESS_WEBHOOK_SECRET",
  noMembershipError: "access_denied",
  keysOf: wordpressKeysOf,
  authorizationOf,
  memberWhoSignedIn,
  membershipsOf,
  // The plugin's webhook names whose membership changed as `member.id`.
  subjectOf: (payload) => subjectFrom((payload as { member?: { id?: unknown } | null } | null)?.member?.id),
};

/** How Ember talks to the deployment's WordPress site, called `WORDPRESS_SITE_NAME`, else WordPress. */
export const wordpressOf = (env: Env): ProviderApi => ({ ...WORDPRESS, name: env.WORDPRESS_SITE_NAME?.trim() || DEFAULT_NAME });

/**
 * The deployment's WordPress keys, or null without all three, or with a site that isn't an https
 * address, or an http one on this computer. The site is the address's origin, by which accounts on it
 * are linked, so they never collide with a Memberful site's.
 */
function wordpressKeysOf(env: Env): MemberfulKeys | null {
  const [url, clientId, clientSecret] = [env.WORDPRESS_URL?.trim(), env.WORDPRESS_CLIENT_ID?.trim(), env.WORDPRESS_CLIENT_SECRET?.trim()];
  if (!url || !clientId || !clientSecret) return null;
  const site = URL.parse(url);
  if (site?.protocol === "https:" || (site?.protocol === "http:" && isLoopback(site))) return { site: site.origin, clientId, clientSecret, provider: wordpressOf(env) };
  console.error("WORDPRESS_URL must be a WordPress site's https address, such as https://example.com, so nobody signs in with WordPress");
  return null;
}

/** Where to sign in at the WordPress site, which sends the browser back to `redirectUri` with `state`. */
function authorizationOf({ site, clientId }: MemberfulKeys, state: string, redirectUri: string): string {
  const authorize = new URL("/", site);
  authorize.search = new URLSearchParams({ ember_authorize: "1", response_type: "code", client_id: clientId, redirect_uri: redirectUri, state }).toString();
  return authorize.href;
}

/**
 * Who signed in at the WordPress site to be given `code`, as its member endpoint says, having exchanged
 * the code for an access token. Null when the site refuses the code, or doesn't answer, or not as it
 * should, which is logged without anything it sent.
 */
async function memberWhoSignedIn({ site, clientId, clientSecret }: MemberfulKeys, code: string, redirectUri: string): Promise<MemberfulMember | null> {
  try {
    const exchanged = await fetch(new URL(`${API_PATH}/token`, site), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri }),
      redirect: "manual",
      signal: AbortSignal.timeout(WORDPRESS_TIMEOUT_MS),
    });
    const accessToken = exchanged.ok ? accessTokenOf(await exchanged.json()) : null;
    if (!accessToken) return refused("token", exchanged, DEFAULT_NAME);
    const asked = await fetch(new URL(`${API_PATH}/member`, site), {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(WORDPRESS_TIMEOUT_MS),
    });
    const member = asked.ok ? memberOf(await asked.json()) : null;
    return member ?? refused("member", asked, DEFAULT_NAME);
  } catch (error) {
    console.error("Signing in with WordPress failed:", error instanceof Error ? error.name : "unknown error");
    return null;
  }
}

/**
 * Whether each of the members of the WordPress site `subjects` name has an active membership, as its
 * memberships endpoint says, asked after at most 100 at a time. Null when the site doesn't answer, or not
 * as it should, as when it leaves anyone out, which is logged without anything it sent.
 */
async function membershipsOf(api: MemberfulApi, subjects: string[]): Promise<Map<string, boolean> | null> {
  const memberships = new Map<string, boolean>();
  for (let i = 0; i < subjects.length; i += MEMBERS_PER_REQUEST) {
    const answered = await membershipsAt(api, subjects.slice(i, i + MEMBERS_PER_REQUEST));
    if (!answered) return null;
    for (const [subject, active] of answered) memberships.set(subject, active);
  }
  return memberships;
}

/** What one request to the memberships endpoint says of `subjects`, or null (`membershipsOf`). */
async function membershipsAt({ site, apiKey }: MemberfulApi, subjects: string[]): Promise<Map<string, boolean> | null> {
  try {
    const asked = await fetch(new URL(`${API_PATH}/memberships`, site), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ids: subjects }),
      redirect: "manual",
      signal: AbortSignal.timeout(WORDPRESS_TIMEOUT_MS),
    });
    const members = asked.ok ? ((await asked.json()) as { members?: unknown } | null)?.members : null;
    if (typeof members !== "object" || members === null) return refused("memberships", asked, DEFAULT_NAME);
    const memberships = new Map<string, boolean>();
    for (const subject of subjects) {
      const active = (members as Record<string, unknown>)[subject];
      if (typeof active !== "boolean") return refused("memberships", asked, DEFAULT_NAME);
      memberships.set(subject, active);
    }
    return memberships;
  } catch (error) {
    console.error("Checking memberships with WordPress failed:", error instanceof Error ? error.name : "unknown error");
    return null;
  }
}

/** The access token in the token endpoint's answer, if it has one. */
function accessTokenOf(answer: unknown): string | null {
  const token = (answer as { access_token?: unknown } | null)?.access_token;
  return typeof token === "string" && token !== "" ? token : null;
}

/** The member the member endpoint's answer describes, or null when it describes none. */
function memberOf(answer: unknown): MemberfulMember | null {
  if (typeof answer !== "object" || answer === null) return null;
  const { id, email, full_name: fullName, active } = answer as Record<string, unknown>;
  const subject = subjectFrom(id);
  if (subject === null) return null;
  const given = typeof email === "string" ? email.trim() : "";
  const emailAddress = given !== "" && given.length <= MAX_EMAIL_ADDRESS_LENGTH ? given : null;
  return {
    id: subject,
    fullName: typeof fullName === "string" ? cutName(fullName) || null : null,
    names: namesOf(fullName, emailAddress),
    emailAddress,
    subscribed: active === true,
  };
}
