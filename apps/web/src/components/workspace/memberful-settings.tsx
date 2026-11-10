import { useState } from "react";
import { MEMBERFUL_CALLBACK_PATH, MEMBERFUL_WEBHOOK_PATH, WORDPRESS_CALLBACK_PATH, WORDPRESS_WEBHOOK_PATH } from "@ember/protocol";
import { Switch } from "@/components/ui/switch";
import { useAccount } from "@/hooks/use-account";
import { useMembershipProvider } from "@/hooks/use-membership-provider";
import { cn } from "@/lib/utils";
import { WORKERS_DASHBOARD } from "./custom-domain-settings";

// The Memberful card in Membership's ways to join: an administrator lets the members of a Memberful site
// join and sign in with their accounts there, whose custom app's keys the deployment keeps as Worker
// secrets. While it's off, the card is its name, a line and its switch, as the project's owner asked
// (2026-10-26): turning it on before the deployment has the keys shows how to make and set them, saving
// nothing, and once it's on, how to have Memberful's webhooks say when a membership lapses, with Members
// only, which keeps everyone else out. Laid out as the other ways to join are, with Members only's
// switch inside it. A deployment whose members sign in with a WordPress site instead shows the card by
// the site's name, with the steps its plugin takes.

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

interface Props {
  /** The Memberful site whose members can sign in, once the deployment has its keys, or null while it hasn't. */
  site: string | null;
  /** Whether the deployment also has what Memberful's webhooks take, so that a member whose membership lapses is signed out. */
  webhooks: boolean;
  /** Where Memberful's switch is: where it was moved to while that's saved, or else where the workspace has it. */
  checked: boolean;
  onCheckedChange: (on: boolean) => void;
  /** Where Members only's switch is, likewise. */
  membersOnly: boolean;
  onMembersOnlyChange: (on: boolean) => void;
  /** Whether a move of Memberful's switch is being saved, while which Members only's waits. */
  memberfulSaving?: boolean;
  /** Whether a move of Members only's switch is being saved, while which Memberful's waits. */
  membersOnlySaving?: boolean;
  /** Why the switch can't be moved while another way to join is on, said in place of what it does, or null. */
  setAside?: string | null;
}

/**
 * Memberful, for administrators: its switch, and while it's on, Members only's, the steps to hear
 * Memberful's webhooks until the deployment does, and where Memberful sends people back to. Turned on
 * before the deployment has the keys, it shows the steps to get them instead, saving nothing, and while
 * it's on without them, which only turning it off mends, it says nobody can sign in with Memberful.
 */
export function MemberfulSettings({
  site,
  webhooks,
  checked,
  onCheckedChange,
  membersOnly,
  onMembersOnlyChange,
  memberfulSaving = false,
  membersOnlySaving = false,
  setAside = null,
}: Props) {
  const { customDomain } = useAccount();
  const { kind, name } = useMembershipProvider();
  const wordpress = kind === "wordpress";
  const [settingUp, setSettingUp] = useState(false);
  // Turned on before the deployment has the keys, which shows the steps to get them and saves nothing, as the server would refuse it.
  const askingForKeys = settingUp && site === null && setAside === null;
  const on = checked || askingForKeys;
  // What it takes shows only while it's on, unless another way to join sets it aside.
  const shown = on && setAside === null;
  const switchTo = (turnOn: boolean) => {
    if (site === null && !checked) return setSettingUp(turnOn);
    onCheckedChange(turnOn);
  };
  // Where Memberful sends people back to, and its webhooks: Ember's address, wherever settings are opened.
  const origin = `${location.protocol}//${customDomain ?? location.host}`;
  const redirectUrl = `${origin}${wordpress ? WORDPRESS_CALLBACK_PATH : MEMBERFUL_CALLBACK_PATH}`;
  const webhookUrl = `${origin}${wordpress ? WORDPRESS_WEBHOOK_PATH : MEMBERFUL_WEBHOOK_PATH}`;
  // What its custom app, or the WordPress site's plugin, calls the address it sends people back to.
  const redirectNamed = wordpress ? "the redirect URL its plugin is given" : "the OAuth redirect URL of its custom app";

  return (
    <section aria-labelledby="memberful-heading" className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3">
      <div className="flex items-center gap-x-[1ch] gap-y-4">
        <div className="min-w-0 flex-1">
          <h3 id="memberful-heading" className={cn("text-base font-semibold", setAside !== null && "text-muted-foreground")}>
            {name}
          </h3>
          <p id="memberful-description" className={cn(NOTE, site === null && checked && "text-negative")}>
            {site === null && checked ? (
              `It's on, but this deployment no longer has its ${name} keys, so nobody can sign in with ${name}.`
            ) : setAside !== null ? (
              setAside
            ) : askingForKeys ? (
              `${name} can't be turned on until this deployment has your ${wordpress ? "WordPress" : "Memberful"} site's keys. These steps give it them.`
            ) : site === null ? (
              `Members of a ${wordpress ? "WordPress" : "Memberful"} site join and sign in with their ${name} account.`
            ) : (
              <>
                Members of <strong className="wrap-anywhere">{site}</strong> join and sign in with their {name} account. Turned off, it lets nobody new
                join, but those who did keep signing in with it.
                {webhooks && " A member whose membership lapses is signed out until it's renewed."}
              </>
            )}
          </p>
        </div>
        <Switch
          checked={on}
          onCheckedChange={switchTo}
          disabled={setAside !== null || membersOnlySaving}
          aria-labelledby="memberful-heading"
          aria-describedby="memberful-description"
        />
      </div>
      {checked && site !== null && setAside === null && (
        <div className="flex items-center gap-x-[1ch] gap-y-4 border-t pt-3">
          <div className="min-w-0 flex-1">
            <div id="members-only-heading">Members only</div>
            <p id="members-only-description" className={NOTE}>
              Nobody else can join but the people you invite, and only they and administrators sign in with a password. Members who have one connect their{" "}
              {name} account as they next sign in.
            </p>
          </div>
          <Switch
            checked={membersOnly}
            onCheckedChange={onMembersOnlyChange}
            disabled={memberfulSaving}
            aria-labelledby="members-only-heading"
            aria-describedby="members-only-description"
          />
        </div>
      )}
      {!shown ? null : site === null ? (
        wordpress ? (
          <WordPressSteps redirectUrl={redirectUrl} webhookUrl={webhookUrl} />
        ) : (
          <Steps redirectUrl={redirectUrl} webhookUrl={webhookUrl} />
        )
      ) : (
        <>
          {!webhooks && <WebhookSteps webhookUrl={webhookUrl} wordpress={wordpress} name={name} />}
          <p className={NOTE}>
            {webhooks ? (
              <>
                {name} sends people back to <span className="wrap-anywhere">{redirectUrl}</span>, {redirectNamed}, and its webhook
                to <span className="wrap-anywhere">{webhookUrl}</span>. If Ember's address changes, change both there too.
              </>
            ) : (
              <>
                {name} sends people back to <span className="wrap-anywhere">{redirectUrl}</span>, {redirectNamed}. If Ember's
                address changes, change it there too.
              </>
            )}
          </p>
        </>
      )}
    </section>
  );
}

/** A link to the Cloudflare dashboard, where the Worker's secrets are set. */
function DashboardLink() {
  return (
    <a href={WORKERS_DASHBOARD} target="_blank" rel="noopener" className="underline">
      Open the Cloudflare dashboard
    </a>
  );
}

/**
 * The steps to let a Memberful site's members sign in: a custom app in Memberful, then its keys as the
 * Worker's secrets, and a webhook with the two secrets that hearing it takes.
 */
function Steps({ redirectUrl, webhookUrl }: { redirectUrl: string; webhookUrl: string }) {
  return (
    <ol aria-label="Steps to let Memberful members sign in" className="flex list-decimal flex-col gap-2 ps-5">
      <li>
        In Memberful, open <em>Settings</em>, <em>Custom applications</em>, and add one. Check <em>Include OAuth tokens with this application</em>, choose{" "}
        <em>Server-side</em>, and give it the OAuth redirect URL <strong className="wrap-anywhere">{redirectUrl}</strong>.
      </li>
      <li>
        Give this Worker three secrets: <code>MEMBERFUL_URL</code>, your site's address, such as https://example.memberful.com, and the app's OAuth identifier
        and client secret as <code>MEMBERFUL_CLIENT_ID</code> and <code>MEMBERFUL_CLIENT_SECRET</code>, with <code>wrangler secret put</code>, or as the type{" "}
        <em>Secret</em> under <em>Settings</em>, <em>Variables and Secrets</em> in the Cloudflare dashboard, since a deploy takes away plain text ones.{" "}
        <DashboardLink />
      </li>
      <li>
        So that a member whose membership lapses is signed out, not only kept from signing in again: <AddWebhook webhookUrl={webhookUrl} /> Then give this
        Worker two more secrets: <WebhookSecrets />.
      </li>
      <li>
        Reload this page, and turn on <em>Memberful</em> again.
      </li>
    </ol>
  );
}

/** The steps to hear Memberful's webhooks, once members can sign in, until the deployment has what it takes. */
function WebhookSteps({ webhookUrl, wordpress, name }: { webhookUrl: string; wordpress: boolean; name: string }) {
  return (
    <>
      <p>A member whose membership lapses can't sign in again, but stays signed in where they are until Ember hears {name}'s webhooks.</p>
      <ol aria-label="Steps to sign out members whose membership lapses" className="flex list-decimal flex-col gap-2 ps-5">
        <li>{wordpress ? <AddWordPressWebhook webhookUrl={webhookUrl} /> : <AddWebhook webhookUrl={webhookUrl} />}</li>
        <li>
          Give this Worker two more secrets: {wordpress ? <WordPressWebhookSecrets /> : <WebhookSecrets />}. <DashboardLink />
        </li>
      </ol>
    </>
  );
}

/** Adding the webhook in Memberful, which says when a member's account, subscription or order changes. */
function AddWebhook({ webhookUrl }: { webhookUrl: string }) {
  return (
    <>
      In Memberful, open <em>Settings</em>, <em>Webhooks</em>, and add one that sends the member, subscription and order events to{" "}
      <strong className="wrap-anywhere">{webhookUrl}</strong>.
    </>
  );
}

/** The two secrets that hearing the webhook takes: its own, to check it came from Memberful, and the API key, to check what it says. */
function WebhookSecrets() {
  return (
    <>
      the webhook's secret key as <code>MEMBERFUL_WEBHOOK_SECRET</code>, and the custom app's API key as <code>MEMBERFUL_API_KEY</code>
    </>
  );
}

/**
 * The steps to let a WordPress site's members sign in: a plugin that speaks Ember's sign-in, given the
 * redirect URL, then its keys as the Worker's secrets, and its webhook with the two secrets that hearing
 * it takes.
 */
function WordPressSteps({ redirectUrl, webhookUrl }: { redirectUrl: string; webhookUrl: string }) {
  return (
    <ol aria-label="Steps to let WordPress members sign in" className="flex list-decimal flex-col gap-2 ps-5">
      <li>
        In WordPress, install a plugin that speaks Ember's sign-in, as Ember's self-hosting guide describes, and give it the redirect URL{" "}
        <strong className="wrap-anywhere">{redirectUrl}</strong>.
      </li>
      <li>
        Give this Worker three secrets: <code>WORDPRESS_URL</code>, your site's address, such as https://example.com, and the plugin's client id and client
        secret as <code>WORDPRESS_CLIENT_ID</code> and <code>WORDPRESS_CLIENT_SECRET</code>, with <code>wrangler secret put</code>, or as the type{" "}
        <em>Secret</em> under <em>Settings</em>, <em>Variables and Secrets</em> in the Cloudflare dashboard, since a deploy takes away plain text ones.{" "}
        <code>WORDPRESS_SITE_NAME</code> names the site on Ember's pages. <DashboardLink />
      </li>
      <li>
        So that a member whose membership lapses is signed out, not only kept from signing in again: <AddWordPressWebhook webhookUrl={webhookUrl} /> Then give
        this Worker two more secrets: <WordPressWebhookSecrets />.
      </li>
      <li>
        Reload this page, and turn this on again.
      </li>
    </ol>
  );
}

/** Pointing the plugin's webhook at Ember, which says whose membership changed. */
function AddWordPressWebhook({ webhookUrl }: { webhookUrl: string }) {
  return (
    <>
      In the plugin's settings, send its webhook to <strong className="wrap-anywhere">{webhookUrl}</strong>.
    </>
  );
}

/** The two secrets that hearing the plugin's webhook takes: its own, to check it came from the site, and the API key, to check what it says. */
function WordPressWebhookSecrets() {
  return (
    <>
      the webhook's secret as <code>WORDPRESS_WEBHOOK_SECRET</code>, and the plugin's API key as <code>WORDPRESS_API_KEY</code>
    </>
  );
}
