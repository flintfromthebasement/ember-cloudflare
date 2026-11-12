import type { Env } from "./env";
import { ACCOUNT_NAME, workspace } from "./workspace";

// The web app manifest, which lets browsers install Ember as an app: Campfire's
// app/views/pwa/manifest.json.erb.

/**
 * What the manifest says the app is: the README's own description, since Campfire's "A chat app from the
 * makers of Basecamp and HEY." isn't this project.
 */
const DESCRIPTION = "A real-time chat app that runs entirely on Cloudflare.";

/**
 * The manifest for a workspace named `name` whose logo is at `logo`, with `shortName` as the home screen
 * label when there is one. Its icons are the logo's variants, or Ember's stock icons while there's no
 * logo. Only the stock icon is offered as maskable: an uploaded logo can reach its edges, which Android
 * would crop, so Android sets it on a plain circle instead. Its screenshots have Campfire's sizes and
 * labels, but they're Ember's own, which `pnpm screenshots` makes.
 */
export function webManifest(name: string, logo: string | null, shortName?: string) {
  const [small, large] = logo ? [`${logo}&size=small`, logo] : ["/logos/app-icon-192.png", "/logos/app-icon.png"];
  const icons: Array<{ src: string; type: string; sizes: string; purpose?: string }> = [
    { src: small, type: "image/png", sizes: "192x192" },
    { src: large, type: "image/png", sizes: "512x512" },
  ];
  if (!logo) icons.push({ src: large, type: "image/png", sizes: "512x512", purpose: "maskable" });
  return {
    name,
    ...(shortName ? { short_name: shortName } : {}),
    icons,
    start_url: "/",
    display: "standalone",
    scope: "/",
    description: DESCRIPTION,
    categories: ["social", "business", "productivity"],
    theme_color: "#ffffff",
    background_color: "#ffffff",
    shortcuts: [
      // Relative, so it resolves against the manifest's address to /rooms/opens/new.
      { name: "New chat room", description: "Open Ember and start a new chat room", url: "rooms/opens/new", icons: [{ src: "/shortcuts/plus.svg", sizes: "any" }] },
      { name: "My profile", description: "Open Ember and view your profile", url: "/users/me/profile", icons: [{ src: "/shortcuts/user.svg", sizes: "any" }] },
    ],
    screenshots: [
      { src: "/screenshots/chat.png", sizes: "1080x2400", form_factor: "narrow", label: "Ember is an installable, self-hosted group chat system." },
      { src: "/screenshots/sidebar.png", sizes: "1080x2400", form_factor: "narrow", label: "Easily invite people. Make rooms. @mentions, DMs, and mobile support." },
      { src: "/screenshots/dark-mode.png", sizes: "1080x2400", form_factor: "narrow", label: "Full support for dark mode, customizable to your brand." },
    ],
  };
}

/** The format a request for the manifest asks for: "" for /webmanifest, "json" for /webmanifest.json, or null for any other path. */
export function manifestFormatOf(pathname: string): string | null {
  const match = pathname.match(/^\/webmanifest(?:\.(.+))?$/);
  return match ? (match[1] ?? "") : null;
}

/** `GET /webmanifest.json`, which pages link, and `/webmanifest`: public, and named after the workspace. */
export async function manifest(env: Env, format: string): Promise<Response> {
  // It's answered only as JSON.
  if (format !== "" && format !== "json") return new Response(null, { status: 406 });
  const account = await workspace(env).account();
  return new Response(JSON.stringify(webManifest(account?.name ?? ACCOUNT_NAME, account?.logo ?? null, env.EMBER_APP_SHORT_NAME?.trim() || undefined)), {
    // Revalidated every time, so an installed app finds a renamed workspace or a new logo.
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
