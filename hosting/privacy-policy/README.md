# Cutlyra — privacy-policy host

Deploys the **committed** standalone policy at
`apps/web/public/privacy-policy.html` to its own static site, so Play Console
has a stable public `https://` URL that needs no account, no login and no
database.

## Production address — use this one (verified 2026-10-29)

```
https://site-dcfc842ddace4944a7faea3dcc59ff84.freebuff.page/privacy-policy
```

- HTTP **200**, `Content-Type: text/html`, `Cache-Control: public, max-age=0,
  must-revalidate`, served by Cloudflare, **no authentication, no login
  redirect**.
- Verified from two vantage points: a direct `curl` and an external fetch.
- Response body SHA-256
  `b295e1c873a000fadf0b7ca799e0d1e8520577d174406c8f4b14acfaf2a3bd50`
  equals the SHA-256 of the committed git blob for
  `apps/web/public/privacy-policy.html` — source, bundle and edge all agree.
- Serves the **29 October 2026** revision (the camera-permission disclosure).
- `/` issues a `301` to `/privacy-policy.html`, which the platform rewrites to
  `/privacy-policy`. Either address works; `/privacy-policy` is the canonical one.

This is the **production** environment of the site, so the address does not
change when preview deployments are refreshed.

## Preview environment (original deployment — preserved)

```
https://site-835c83d428b64a81980da726f9591268.freebuff.page/privacy-policy
```

Kept published as a fallback: production was promoted only after it passed the
same verification, so the original deployment was never torn down first. It
still serves the older **4 October 2026** revision and is therefore **not** the
address to give Play Console. Either republish it from the current bundle or
unpublish it once the owner is satisfied — production is the canonical URL.

Site id `1ed8e244-6839-4026-a5c3-54950fdfa004` ("Cutlyra Privacy Policy").
The URL is a `freebuff.page` host owned by this Cutlyra site — no other
project's domain, identity or sender is used anywhere on it.

## Files

| File | Purpose |
| --- | --- |
| `worker.js` | Serves static assets, plus one `301` from `/` to the policy. No database, no auth, no outbound network call. |
| `manifest.json` | Sites deploy manifest: ESM worker + `./public` asset directory. |
| `public/privacy-policy.html` | The policy itself. |

## ⚠ Keep it in sync

`public/privacy-policy.html` here is a **byte-for-byte copy** of
`apps/web/public/privacy-policy.html`. The committed file under `apps/web` is
the single source of truth.

### Automated guard

`bun-ci.yml` now fails the Linux invariants job whenever these copies disagree
**or** the live production URL stops serving the committed bytes. It runs on
every push and pull request, needs no secret and no paid monitoring service,
and is verified to fail on real drift (pointing it at the stale preview URL
produces a mismatch). The network call deliberately lives in CI, not in
`scripts/invariants.sh`, so the repo itself still works fully offline.

### Manual re-sync

Whenever the policy at `apps/web` changes, re-copy and redeploy, then re-verify
the hashes match:

```bash
git show origin/main:apps/web/public/privacy-policy.html \
  > hosting/privacy-policy/public/privacy-policy.html
# redeploy through the Sites tooling, then:
sha256sum hosting/privacy-policy/public/privacy-policy.html
curl -s https://site-835c83d428b64a81980da726f9591268.freebuff.page/privacy-policy | sha256sum
```

Both must print the same digest as the committed file. A stale hosted policy
would make the Play listing's privacy URL inaccurate, so treat this as part of
any privacy change rather than an afterthought.
