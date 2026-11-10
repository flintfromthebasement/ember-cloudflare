# PMPro's fork of Ember

This copy of Ember runs PMPro's chat at chat.paidmembershipspro.com. It is a fork of
[NYLLON-SOFTWARE/ember-cloudflare](https://github.com/NYLLON-SOFTWARE/ember-cloudflare): some of
our work goes upstream as pull requests, and some stays here. Read this before you branch, commit or
deploy, so the two never mix.

This file and the pointer at the end of `AGENTS.md` live only on `pmpro`. Never let them reach a
branch you open upstream.

## Remotes

| Remote | Repo | Use |
|---|---|---|
| `origin` | `NYLLON-SOFTWARE/ember-cloudflare` | Upstream. Fetch only; never push. PRs target its `main` (it has no `dev`). |
| `fork` | `flintfromthebasement/ember-cloudflare` | Ours. Push every branch here. |

Check `git remote -v` before every push.

## Branches

| Branch | What it is |
|---|---|
| `pmpro` | **The deploy branch.** Upstream `main`, plus our commits that stay here, plus every upstream-PR branch merged in. chat.paidmembershipspro.com runs whatever `pmpro` is. |
| `<topic>` (e.g. `bot-thread-read`) | One upstream PR: branched from `origin/main`, holding nothing PMPro-specific. |

There is no other long-lived branch. Upstream's `claude/project-thread-*` branches are the maintainers'
work in progress, so leave them alone.

## Is a change upstream material, or ours?

Ask whether any Ember deployment would want it, with no PMPro in the picture.

- **Upstream:** general features, with generic names in code, routes, settings and copy (no
  "PMPro", no PMPro-only assumptions). Examples: bots reading threads (#273), files in bot deliveries
  (#274), a request-to-join flow for private rooms, an import API, email digests.
- **Ours, at least for now:** deployment config (`wrangler.jsonc` names), anything only PMPro needs,
  and features upstream has said no to or hasn't decided on yet. The WordPress sign-in
  (`1eab1a18`) stays here for now: it uses generic names, but a bare WordPress site rarely manages
  access by itself, so it's unclear upstream would want it.
- **Ask upstream first:** big product changes, such as posts rooms (slow, Facebook-group-style
  rooms where every reply is in a thread) and a home feed across rooms. Open an issue before writing
  code; if they decline, the work becomes ours.

Opening an issue or PR upstream is public, so it needs Jason's go-ahead.

## Workflows

**Upstream PR**

```sh
git fetch origin
git switch -c <topic> origin/main
# work, then: pnpm typecheck && pnpm test && pnpm build
git push -u fork <topic>
gh pr create -R NYLLON-SOFTWARE/ember-cloudflare --base main --head flintfromthebasement:<topic>
git switch pmpro && git merge --no-ff <topic>   # ship it to our deploy before upstream merges
git push fork pmpro
```

Keep upstream PRs small and one idea each. Follow `AGENTS.md` and match upstream's style, commit
messages included. When review asks for changes, fix them on `<topic>` and merge `<topic>` into
`pmpro` again.

**Ours-only change:** commit on `pmpro` (or a short branch from it, merged back) and push to `fork`.

**Sync with upstream** (often, and always before starting an upstream PR you'll also deploy):

```sh
git fetch origin
git switch pmpro && git merge origin/main   # merge, never rebase: pmpro is what's deployed
pnpm install && pnpm typecheck && pnpm test && pnpm build
git push fork pmpro
```

Once upstream merges one of our PRs, its topic branch is done: delete it locally and on `fork`.

## Deploying

Deploy from a clean `pmpro` that is pushed to `fork`, after `pnpm typecheck`, `pnpm test` and
**`pnpm build`**. Run the build on its own: the deploy uploads whatever is in `apps/web/dist`, so a
build skipped because a test failed ships the new Worker with the old web app. The Worker is
`pmpro-chat` (R2 bucket `pmpro-chat-files`, DO SQLite storage) in PMPro's Cloudflare account.

Run the deploy in an **empty environment**. `scripts/deploy.ts` uploads every key it knows that the
environment holds (`RESEND_API_KEY`, Memberful, WordPress, Turnstile and more) as Worker secrets, and
Flint's shell profile loads `~/.env`, which holds unrelated ones, as well as `CF_*` tokens that wrangler
reads for other accounts. On 2026-11-10 a deploy from the normal shell uploaded the basement's
`RESEND_API_KEY` to `pmpro-chat`; it was deleted two minutes later.

```sh
T=$(grep '^CF_API_TOKEN_PMPRO_EMBER=' ~/.env | cut -d= -f2- | tr -d '"')
A=$(curl -s -H "Authorization: Bearer $T" https://api.cloudflare.com/client/v4/accounts \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['result'][0]['id'])")
env -i PATH="$PATH" HOME="$HOME" CLOUDFLARE_API_TOKEN="$T" CLOUDFLARE_ACCOUNT_ID="$A" pnpm run deploy
```

The deploy's first line says which keys it is uploading: only `CLOUDFLARE_ACCOUNT_ID` is expected. The
WordPress sign-in keys are already secrets on the Worker and stay without being passed. Afterwards,
check `https://chat.paidmembershipspro.com/api/health` and that a string new in the web app is in the
live `assets/index-*.js`.

`scripts/deploy.test.ts` fails on `pmpro` by design: it expects the stock `ember` names that
`wrangler.jsonc` renames. Every other test passes.

## Admin changes on the live chat

Flint has an administrator account on chat.paidmembershipspro.com, "PMPro Admin", whose email and
password are `EMBER_PMPRO_EMAIL` and `EMBER_PMPRO_PASSWORD` in `~/.env`. Use it for room settings and
other admin changes; Flint's and Nugget's bot accounts can't make them. Sign in with
`POST /api/session` (`{"emailAddress", "password"}`), sending `Origin: https://chat.paidmembershipspro.com`
and `Sec-Fetch-Site: same-origin`, or Ember refuses the request as cross-site. Keep the cookie in the
scratchpad, make the change (for example `PATCH /api/rooms/<id>` with `{"posts": true}`), then
`DELETE /api/session` and delete the cookie file.

## Related code outside this repo

- `pmpro-ember` WordPress plugin (`/home/flint/projects/pmpro-ember/`): the site side of the
  WordPress sign-in, using the generic wire names `ember/v1` and `X-Ember-Webhook-Signature`.
- Flint's and Nugget's Ember bots live in the Stranger Agents gateway (`strangerstudios/agents`),
  not here. See `docs/ops/nugget.md` in Flint's home repo.

## Open PRs and status

| PR | Branch | Status |
|---|---|---|
| [#273](https://github.com/NYLLON-SOFTWARE/ember-cloudflare/pull/273) Let bots read a thread | `bot-thread-read` | Open, no review yet; merged into `pmpro` |
| [#274](https://github.com/NYLLON-SOFTWARE/ember-cloudflare/pull/274) Give bots the files people post | `bot-attachments` | Open, no review yet; merged into `pmpro` |
| — Posts rooms (forum-style rooms, newest activity first) | `posts-rooms` | Not proposed upstream yet: open an issue first. Merged into `pmpro` and live since 2026-11-10 |

`pmpro` also carries `f351abf2`, an early draft of #273 that the PR replaced. Drop it at the next
sync if it conflicts. Update this table whenever a PR opens, merges or closes.
