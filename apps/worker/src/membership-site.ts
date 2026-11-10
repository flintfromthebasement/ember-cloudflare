import { inTermsOf, type MembershipProvider } from "@ember/protocol";
import type { Env } from "./env";
import { MEMBERFUL, type MemberfulApi, type MemberfulKeys, type ProviderApi } from "./memberful-api";
import { wordpressOf } from "./wordpress-api";

// The membership site whose members sign in to this deployment: a WordPress site once `WORDPRESS_URL`
// names one, or else a Memberful site, as before. Everything above the site's API, from linking accounts
// to suspending lapsed members, is Memberful's, and the same for either, with the site's origin as the
// issuer accounts there are linked by.

/** How Ember talks to the deployment's membership site, whether or not it has the keys yet. */
export const providerOf = (env: Env): ProviderApi => (env.WORDPRESS_URL?.trim() ? wordpressOf(env) : MEMBERFUL);

/** The kind of the deployment's membership site, and what pages call it. */
export function membershipProviderOf(env: Env): MembershipProvider {
  const { kind, name } = providerOf(env);
  return { kind, name };
}

/** `text`, which talks of Memberful, as it reads for the deployment's membership site. */
export const inProviderTerms = (env: Env, text: string) => inTermsOf(text, providerOf(env).name);

/** The deployment's membership site and the keys to sign in with it, or null without them. */
export const membershipKeysOf = (env: Env): MemberfulKeys | null => providerOf(env).keysOf(env);

/** What asking the membership site whose memberships are active takes, or null unless the deployment has its sign-in keys and API key. */
export function membershipApiOf(env: Env): MemberfulApi | null {
  const keys = membershipKeysOf(env);
  const apiKey = keys && env[keys.provider.apiKeyName]?.trim();
  return keys && apiKey ? { site: keys.site, apiKey, provider: keys.provider } : null;
}
