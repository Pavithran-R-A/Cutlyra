# Cutlyra — privacy-policy host

Deploys the **committed** standalone policy at
`apps/web/public/privacy-policy.html` to its own static site, so Play Console
has a stable public `https://` URL that needs no account, no login and no
database.

## Deployed address (verified 2026-10-29)

```
https://site-835c83d428b64a81980da726f9591268.freebuff.page/privacy-policy
```

- HTTP **200**, `Content-Type: text/html`, served by Cloudflare, **no
  authentication, no redirect to a login**.
- Verified from two vantage points: a direct `curl` and an external fetch.
- Response body SHA-256 was
  `32574fc02202df09cb20b8cfb1073b10d4a45d986166591f77b88f82853fbfc1`,
  **byte-identical** to `apps/web/public/privacy-policy.html` at `main`.
- `/` issues a `301` to `/privacy-policy.html`, which the platform rewrites to
  `/privacy-policy`. Either address works; `/privacy-policy` is the canonical one.

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
