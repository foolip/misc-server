# marquee on Cloudflare

This directory replaces the "marquee" nginx droplet (`debian/marquee/`) with a
Cloudflare Worker in front of one R2 bucket. See
[whatwg/misc-server#107](https://github.com/whatwg/misc-server/issues/107).

This is phase 1 of the migration (see [Migration plan](#migration-plan)). Nothing
here is deployed yet, because there is no Cloudflare account yet.

## Architecture

```
            ┌──────────────────────────── Cloudflare ─────────────────────────────┐
 browser ──▶│ Always Use HTTPS ─▶ Worker "marquee" ──────▶ R2 bucket whatwg-sites │
            │  (TLS, compression)  (src/, hosts.json)                             │
            └──────────────────────────────────────────────────────────────────────┘
```

- **One Worker** (`marquee`) serves all 49 hosts in `debian/marquee/DOMAINS`.
  17 of them only redirect; the other 32 serve files.
- **One R2 bucket, `whatwg-sites`** (binding `BUCKET`), holds every host's
  files at `<host>/<path>`, mirroring marquee's `/var/www/<host>/<path>`:
  ```
  whatwg.org/index.html
  whatwg.org/404
  dom.spec.whatwg.org/index.html
  dom.spec.whatwg.org/commit-snapshots/<sha>/index.html
  dom.spec.whatwg.org/review-drafts/2024-06/index.html
  html.spec.whatwg.org/multipage/parsing.html
  forums.whatwg.org/bb3/viewtopic.php__f=3&p=8538
  ```
  The redirect-only hosts have no objects. R2 has no directories: a directory
  exists if any key starts with `<host>/<dir>/`.
- **Snapshots are write-once.** `config/lock-rules.json` has an R2
  [bucket lock](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
  rule with indefinite retention for `<host>/commit-snapshots/` and
  `<host>/review-drafts/` of every host that serves files (64 rules; the limit
  is 1,000). Locked objects can't be overwritten or deleted. R2 can't lock
  individual objects, only prefixes, which is why there is one rule per host.
  See [Snapshot lock rules](#snapshot-lock-rules).
- **`config/hosts.json`** describes each host: redirects, `location` blocks,
  content types, error pages and headers. It is generated from the nginx
  config by `tools/nginx-to-json.mjs`.

Files:

| Path | What |
| --- | --- |
| `wrangler.jsonc` | Worker config: R2 bindings, staging env, production routes |
| `src/index.mjs` | Worker entry point; passes the bucket and cache to the handler |
| `src/handler.mjs` | Request handling (redirects, files, error pages, headers) |
| `src/locations.mjs` | nginx `location` matching |
| `src/path.mjs` | URI decoding/normalization, extensions, escaping |
| `src/listing.mjs` | fancyindex-style directory listings |
| `tools/nginx-to-json.mjs` | nginx → `config/hosts.json` converter |
| `config/hosts.json` | Generated config (committed) |
| `tools/lock-rules.mjs` | `config/hosts.json` → `config/lock-rules.json` |
| `config/lock-rules.json` | Generated R2 lock rules for snapshots (committed) |
| `tools/try-local.mjs` | Seed local R2 from production and compare (see below) |
| `vendor/mime.types` | The `mime.types` marquee uses (see below) |
| `test/*.test.mjs` | Unit tests and the offline replay of `../test/` |

The handler takes the bucket and cache as arguments, so all of it runs under
Node in tests with in-memory fakes.

### Request handling

The Worker reproduces what nginx does on marquee:

1. **Host.** From the request URL. In the staging environment only, the
   `X-Marquee-Host` request header overrides it. Production ignores that
   header. An unknown host gets `421`.
2. **Server-level `return`** (the redirect-only hosts) runs before anything
   else, for any method. `$request_uri` and `$1`–`$9` are substituted
   (non-participating captures are empty), and relative targets are made
   absolute with the request's host, like nginx's `absolute_redirect on`.
3. **Path.** Percent-decoded (`%2F` counts as `/`), slashes merged, dot
   segments resolved. Invalid escapes and `..` above the root get `400`.
4. **Location matching**, exactly as nginx does it: `=` exact match; else the
   longest prefix, which wins if it's `^~`; else the first matching regex
   (`~`, `~*`) in config order; else the longest prefix. `whatwg.conf` is
   included at the top of each server block, so its locations (including
   `~* \.js$`) come before each site's own regexes.
5. **Location `return`**: redirect, or for `return 410;` and similar, the
   error handling in step 9.
6. Methods other than GET and HEAD get `405`.
7. **Files.** The R2 key is `<host><path>`. The query string is ignored,
   except on forums.whatwg.org (below).
   - A path ending in `/` tries the `index` files (default `index.html`) as an
     internal redirect, which goes through location matching again, as in
     nginx. With no index file, `fancyindex on` gives a directory listing.
   - A path without a trailing slash that has no object but has objects under
     `path/` gets `301` to `path/`, keeping the query string.
   - `bucket.get(key, { onlyIf: request.headers, range: request.headers })`
     gives `304`, `412` and `206` responses. Unsatisfiable ranges get `416`.
   - HEAD gets the same headers and no body.
8. **Content-Type.** The lowercased extension of the last path segment is
   looked up in the `types` in effect, then `default_type`: location overrides
   server overrides http level (`application/octet-stream`). `charset utf-8`
   appends `; charset=utf-8` only to nginx's default `charset_types`
   (`text/html`, `text/xml`, `text/plain`, `text/vnd.wap.wml`,
   `application/javascript`, `application/rss+xml`) and never to a type that
   already has parameters. The R2 object's own content type is ignored.
9. **Errors.** If the location has an `error_page` for the status (html.spec
   `404 /404.html`; whatwg.org `404 /404` and `410 /410`; lists `404 /404`),
   that URI is served through the normal pipeline with the original status,
   once (no recursion, like `recursive_error_pages off`). Otherwise an
   nginx-style default page.
10. **Headers.** Every response, errors included, gets
    `Access-Control-Allow-Origin: *`,
    `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
    and `X-Content-Type-Options: nosniff`. `cache.conf` is applied: content
    types matching `font` or `image/` get `Cache-Control: max-age=604800` and
    `Expires`, for statuses 200, 201, 204, 206, 301, 302, 303, 304, 307 and
    308 only. html.spec.whatwg.org/print.pdf also gets
    `Content-Disposition: inline; filename=html-standard.pdf`.

**forums.whatwg.org** has three special things, which the converter recognizes
exactly: `location / { index index.php; }`, `location = / { return 301 /bb3/; }`,
and `location ~ \.php` with an `if` that strips a trailing `&?sid=[a-z0-9]*`
from the query with a permanent redirect (feature `strip-sid` in hosts.json),
followed by `try_files "${uri}__${args}" $uri =404`.

**Directory listings** imitate `fancyindex` with
`fancyindex_css_href https://resources.whatwg.org/nginx-fancyindex-whatwg.css`
and `fancyindex_exact_size off`: directories first, dotfiles hidden, sort by
name by default, `/commit-snapshots` by date (newest first) and
`/review-drafts` by name descending; `?C=N|S|M&O=A|D` changes the sort. File
dates come from `customMetadata.mtime` (where rclone stores the original
mtime), falling back to `uploaded`. A subdirectory's date is the newest date
of anything in it, so a listing lists every object under its prefix (paginated,
at most `MAX_LIST_CALLS` = 200 calls of 1000 objects). The rendered page is
cached with the Cache API for 5 minutes.

## nginx is the source of truth (until cutover)

While marquee is live, `debian/marquee/` is the source of truth. After changing
any of these:

- `debian/marquee/DOMAINS`
- `debian/marquee/nginx/sites/*.conf`
- `debian/marquee/nginx/conf/whatwg.conf`, `whatwg-headers.conf`, `cache.conf`

run

```sh
cd cloudflare
npm run convert   # writes config/hosts.json and config/lock-rules.json
```

and commit the updated files. CI (`.github/workflows/cloudflare.yml`) runs
`npm run check-config` and fails if either is out of date.

The converter fails on any directive it doesn't know, so a config change that
the Worker can't reproduce is caught in CI rather than in production. It
ignores `listen`, `ssl_*` and `gzip*`, which Cloudflare handles.
`nginx/conf/http.conf` (port 80 and ACME challenges) is not converted:
Cloudflare's "Always Use HTTPS" replaces it, and certbot, dhparam and fdupes
aren't needed.

**After cutover**, delete `debian/marquee/`, `tools/nginx-to-json.mjs`,
`vendor/mime.types` and the converter tests, and edit `config/hosts.json`
directly. Keep `tools/lock-rules.mjs` and its check, generating the rules from
`hosts.json`.

### `vendor/mime.types`

marquee runs Debian's nginx 1.18 package, which installs `/etc/nginx/mime.types`
from Debian's own packaging (`debian/conf/mime.types`), not upstream's
`conf/mime.types`. They differ: Debian's maps `.woff` to `application/font-woff`
(which production serves; see `test/content-type.mjs`) and has no `woff2`
entry, while upstream nginx has used `font/woff` since 1.15.x, including
`release-1.18.0`.

The vendored file was extracted from
`http://archive.ubuntu.com/ubuntu/pool/main/n/nginx/nginx-common_1.18.0-6ubuntu14_all.deb`
(SHA-256 `1237fe9680d22fe95adc0983d82ebfe08fad637797ef19fc35d4cb6867658e5d`),
Ubuntu jammy's package based on Debian's `1.18.0-6`, because deb.debian.org and
salsa.debian.org aren't reachable from the environment this was built in.
Ubuntu focal's `nginx-common_1.18.0-0ubuntu1.7` ships an identical file.
Debian bullseye's `1.18.0-6.1` is expected to be the same but was not checked
directly; comparing with `/etc/nginx/mime.types` on marquee would settle it.

## Tests

```sh
cd cloudflare
npm test             # node --test: unit tests + offline replay
npm run check-config # hosts.json up to date?
npm run build        # bundle with the pinned wrangler (dry run)
```

There are no dependencies; `npm test` only needs Node.js 22 or later.
`wrangler` is run with `npx` at a pinned version (`4.156.2`) in `package.json`.

**Offline replay.** `test/replay.test.mjs` runs the production test suite
(`../test/{redirects,content-type,caching,cors,hsts,x-headers}.mjs`) against
the Worker without a network. It defines mocha's `describe`/`specify` on top of
`node:test` and replaces global `fetch` with a call into the Worker. The bucket
is a fake in which every key exists, except keys with a path segment named
`foo` (the 404 cases). Tests of `http:` URLs (handled by "Always Use HTTPS") and
of hosts marquee doesn't serve (blog, wiki, participate, build) are skipped, as
is `certs.mjs`. `../test/` is unchanged.

Result at the time of writing: 315 pass, 0 fail, 99 skipped (90 `http:`,
9 for other hosts).

## Trying it locally

`wrangler dev` runs the Worker in workerd with a local R2 bucket, so it can be
tried without a Cloudflare account. `tools/try-local.mjs` fills local R2 with a
sample of production and compares the two:

```sh
cd cloudflare
npm run local:seed     # copy ~180 production files into local R2 (.wrangler/state)
npm run dev            # wrangler dev --env staging, on http://localhost:8787
# in another terminal:
npm run local:compare  # request ~600 URLs from production and locally, diff them
curl -i -H 'X-Marquee-Host: dom.spec.whatwg.org' http://localhost:8787/commit-snapshots/
```

The sample is every `https:` URL in `../test/*.mjs` for a host the Worker
serves, the error pages, print.pdf, forums.whatwg.org/bb3/, and the three
newest commit snapshots and review drafts of dom and url. `local:compare` also
requests each URL with `/foo` appended, and compares the status and the
`Location`, `Content-Type`, `Cache-Control`, `Content-Disposition`, CORS, HSTS
and nosniff headers. Expect print.pdf to differ (see
[Differences from nginx](#differences-from-nginx)), and anything not in the
sample to be `404` locally. Local R2 has no rclone mtimes, so listing dates are
seeding times.

## Deploying

There is no Cloudflare account yet, so none of this has been run. The account
should be in shared custody of the people on admin@whatwg.org.

One-time setup (phase 2/4):

1. Create the R2 bucket `whatwg-sites` and apply the lock rules
   (`npm run lock-rules:apply`, see [Snapshot lock rules](#snapshot-lock-rules))
   before copying any snapshots into it.
2. In the whatwg.org zone, turn on **SSL/TLS → Edge Certificates → Always Use
   HTTPS** (the `http:` → `https:` 301s, replacing `http.conf`).
3. Create an API token for deploys (Workers Scripts: Edit, Workers Routes: Edit,
   Account: Workers R2 Storage: Read) if deploys run from CI.

Staging:

```sh
npm run deploy:staging
curl -H 'X-Marquee-Host: dom.spec.whatwg.org' https://marquee-staging.<account>.workers.dev/
```

`marquee-staging` uses the same bucket (read-only) and takes the host from
`X-Marquee-Host`. Redirect `Location`s use the real host, as nginx would. Note
that the Cache API does nothing on `workers.dev`, so listings aren't cached
there.

Production:

```sh
npm run deploy
```

The production Worker has `workers_dev: false` and starts with **no routes**,
so deploying it serves nothing until hosts are added.

## Cutover (phase 5)

Hosts move one at a time, as Worker
[Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).
Do html.spec.whatwg.org last.

For each host:

1. Make sure R2 has the host's files and that deploys are writing to both
   marquee and R2 (phase 3).
2. Test it on staging with `X-Marquee-Host`, and run the production test suite
   against the staging Worker if useful.
3. Add the host to `routes` in `wrangler.jsonc`:
   ```jsonc
   "routes": [
     { "pattern": "dom.spec.whatwg.org", "custom_domain": true }
   ]
   ```
   and deploy. Cloudflare creates the DNS record and certificate for a Custom
   Domain, replacing the DNS-only record that points at marquee. (If a DNS
   record for the host already exists, Cloudflare may ask for it to be deleted
   first.)
4. Run `npm test` in `../test/` against production.

**Rollback:** remove the entry from `routes` and deploy (or detach the Custom
Domain in the dashboard), then restore the DNS-only A/AAAA record pointing at
marquee. marquee keeps serving until phase 6.

## Deploy scripts (phase 3, not done here)

Today three places deploy to marquee with rsync over ssh using the `MARQUEE_*`
secrets. In phase 3 they write to R2 too, with `aws s3 sync` (preinstalled on
GitHub's runners) against the R2 endpoint, using organization secrets `R2_*`:

```sh
aws s3 sync out/ "s3://whatwg-sites/$HOST/" \
  --endpoint-url "$R2_ENDPOINT" --region auto \
  --exclude 'commit-snapshots/*' --exclude 'review-drafts/*'   # add --delete where rsync has it
```

Most files change with every build, so re-uploading unchanged ones costs
little.

- **whatwg/whatwg.org `deploy.sh`** uses `rsync --delete` for whatwg.org and
  other sites, including lists.whatwg.org (~88k files) and forums.whatwg.org
  (~4k files). Equivalent: sync each host to `whatwg-sites/<host>/` with
  `--delete`.
- **`resources.whatwg.org/build/deploy.sh`** (every Bikeshed spec, via the
  spec-factory workflows) syncs without `--delete`, and adds
  `commit-snapshots/<sha>/` and `review-drafts/<name>/`. Equivalent: sync the
  spec to `whatwg-sites/<host>/` without `--delete`, and upload new snapshot
  directories as below.
- **whatwg/html's workflow** syncs with `--delete` but excludes
  `commit-snapshots` and `review-drafts`, then syncs those separately.
  Equivalent: the same. The excludes are now required: deleting a locked
  object fails, which would fail the sync.

**Snapshots.** `commit-snapshots/` and `review-drafts/` are locked, so any
attempt to overwrite an object there fails, even with identical content, and
`aws s3 sync` would try whenever the local file looks newer. Upload only the
new snapshot directory, and skip it if it already exists (a re-run deploy for
the same commit, or a review draft that is rebuilt on every deploy, which needs
checking in `deploy.sh`):

```sh
dest="s3://whatwg-sites/$HOST/commit-snapshots/$SHA/"
if [ -z "$(aws s3 ls "$dest" --endpoint-url "$R2_ENDPOINT" --region auto)" ]; then
  aws s3 sync "out/commit-snapshots/$SHA/" "$dest" --endpoint-url "$R2_ENDPOINT" --region auto
fi
```

Never sync the whole `commit-snapshots/` or `review-drafts/` directory. If a
deploy fails half-way through a new snapshot, the files already uploaded are
locked; rerunning the same `sync` only uploads the missing ones as long as the
local files aren't newer, so a retry may need the lock rule disabled briefly.
For a stricter guard, upload with `aws s3api put-object --if-none-match '*'`
per file, which R2 supports
([conditional operations](https://developers.cloudflare.com/r2/api/s3/conditional-operations/)).

**Listing dates.** Directory listings use `customMetadata.mtime`, which
`aws s3 sync` doesn't set, so dates are upload times (the bulk copy from
marquee with rclone in phase 2 keeps the original mtimes). For commit
snapshots, upload time and build time are nearly the same.

### Deploy credentials

The R2 credentials are secrets of a GitHub Actions environment named
`production` in each deploying repository, not organization secrets. The
environment only allows the `main` branch, so a workflow run on any other
branch never gets the credentials, however its workflow file was edited. The
`GITHUB_REF` checks in `deploy.sh` and similar don't protect against that, since
code on the branch can change them.

```sh
export R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
cloudflare/tools/setup-deploy-environment.sh whatwg/dom whatwg/fetch …
```

creates or updates the environment and its secrets (re-run it to rotate the
token). It names `main` explicitly rather than using "protected branches only",
because that option only counts classic branch protection, and lets every
branch deploy when a repository has none. Protecting `main` is what makes
"merged to `main`" mean "reviewed", so the script refuses a repository unless
`main` has a ruleset requiring pull requests (`REQUIRE_RULESET=0` skips that
check, for testing in a fork). Converting the whatwg repositories from classic
branch protection to rulesets is part of the migration:

```sh
DELETE_CLASSIC=1 cloudflare/tools/setup-main-ruleset.sh whatwg/dom whatwg/fetch …
```

creates or updates a ruleset named `main` on the default branch: no deletion,
no force pushes, linear history, a pull request with 1 approval, the `Participation` and `Build`
checks passing, and no bypass. It skips a repository whose default branch
doesn't report both checks (every PR there would be blocked; `FORCE=1`
overrides), and only deletes the classic protection after checking the ruleset
is in effect.

Workflows use the environment only for pushes to `main`, so PR builds still
run without it:

```yaml
environment: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && 'production' || '' }}
```

## Snapshot lock rules

`npm run lock-rules` (also run by `npm run convert`) writes
`config/lock-rules.json` from `config/hosts.json`: two rules per host that
serves files, for example

```json
{"id":"dom.spec.whatwg.org-commit-snapshots","enabled":true,"prefix":"dom.spec.whatwg.org/commit-snapshots/","condition":{"type":"Indefinite"}}
```

CI checks that the file is up to date, so adding a host to `DOMAINS` (or, after
cutover, to `hosts.json`) without regenerating the rules fails CI. Apply them
with

```sh
npm run lock-rules:apply   # wrangler r2 bucket lock set whatwg-sites --file config/lock-rules.json
```

which replaces all lock rules on the bucket, so the committed file is the
complete set. Run it whenever the file changes, before deploying snapshots for
a new host.

Things to know about the locks:

- They apply to existing objects as well as new ones, and take precedence over
  lifecycle rules.
- A bad snapshot can't be fixed or removed until someone with admin access
  disables its rule. The rules are not a compliance lock: an account admin can
  remove them. Deploy tokens should be R2 object read/write tokens, which (to
  be verified on the real account) can't change bucket settings.
- A bucket with lock rules can't be emptied.

## Differences from nginx

Intentional or unavoidable differences:

1. **print.pdf keeps the standard headers.** In nginx, an `add_header` in a
   location drops all inherited `add_header`s, so production serves
   html.spec.whatwg.org/print.pdf without CORS, HSTS or nosniff. The Worker
   adds the location's `Content-Disposition` on top of the standard headers.
2. **HTTP → HTTPS** is done by Cloudflare's "Always Use HTTPS", not by the
   Worker. TLS, HTTP/2/3 and compression are Cloudflare's, so TLS versions,
   ciphers and `Content-Encoding` differ.
3. **ETag** is R2's (an MD5 or multipart hash), not nginx's `"mtime-size"`.
   Every ETag changes once at cutover.
4. **Last-Modified** is the rclone mtime (else the upload time). R2 evaluates
   `If-Modified-Since` against the upload time, so a request with only
   `If-Modified-Since` usually gets `200` rather than `304`. `If-None-Match`
   works normally, and browsers send both.
5. **Multiple ranges** (`Range: bytes=0-1,5-6`) get the whole object with
   `200` instead of `multipart/byteranges`.
6. **Directory listings** imitate fancyindex's markup, not byte for byte.
   Directory dates are the newest date of anything inside (nginx shows the
   directory's mtime). Listings are cached for 5 minutes. A directory with
   more than 200,000 objects below it shows `-` for the dates of
   subdirectories past that point; they sort as oldest. Empty directories don't exist in R2, so they are `404`
   instead of an empty listing.
7. **Location headers and `$request_uri`.** `$request_uri` comes from the URL
   as Workers parsed it, which has dot segments resolved and some characters
   percent-encoded, where nginx uses the raw request line. Location values
   with spaces or non-ASCII are percent-encoded; nginx sends raw bytes.
8. **Paths with invalid UTF-8** (after decoding) can't name an R2 key, so they
   get `404`. nginx could serve such file names from disk.
9. **Methods.** nginx answers a POST to a missing file with `404` and to an
   existing one with `405`; the Worker answers `405` either way. Redirects
   apply to every method in both.
10. **Default error pages** end with `nginx` instead of `nginx/1.18.0`, and
    there is no `Server: nginx` header (Cloudflare sends `Server: cloudflare`).
11. **Unknown hosts** get `421`. With Custom Domains, only configured hosts
    reach the Worker.
12. **No edge caching of files.** The Worker runs in front of Cloudflare's
    cache, so every file request reads from R2 (with the same `Cache-Control`
    as nginx for browsers). This could be added with the Cache API later.

## Migration plan

- **Phase 0:** inventory marquee (logical size with hard links counted, file
  counts, traffic).
- **Phase 1 (this directory):** the Worker.
- **Phase 2:** create the bucket and apply `config/lock-rules.json` so
  snapshots are write-once. Bulk-copy with rclone, keeping mtimes. Check how
  rclone should treat symlinks and hard links on marquee.
- **Phase 3:** deploys write to both marquee and R2.
- **Phase 4:** move the whatwg.org DNS zone from DigitalOcean to Cloudflare
  with DNS-only records. Test the staging Worker.
- **Phase 5:** cut over one host at a time, html.spec last.
- **Phase 6:** decommission marquee.

## Open questions

- Whether Worker Custom Domains get certificates for two-level hostnames like
  `dom.spec.whatwg.org`. Universal SSL only covers `whatwg.org` and
  `*.whatwg.org`; Custom Domains are supposed to issue their own certificate
  per hostname, but this needs checking on the real account (otherwise:
  Advanced Certificate Manager for `*.spec.whatwg.org` and
  `*.idea.whatwg.org`).
- The Cloudflare account doesn't exist yet. It should be in shared custody of
  the people on admin@whatwg.org. DigitalOcean (current DNS) and registrar
  access exist, so the zone move in phase 4 isn't blocked on access.
- Per-request limits on R2 operations for large listings
  (`/commit-snapshots/` on html.spec.whatwg.org has thousands of snapshot
  directories). `MAX_LIST_CALLS` may need tuning, or listings could be
  precomputed at deploy time.
- Whether R2 lock rules accept these rule IDs (host name plus directory, up
  to 46 characters) and whether `wrangler dev`'s local R2 enforces locks
  (probably not, so locks can only be tested on the real account).
- Whether Debian bullseye's `mime.types` is identical to the vendored one
  (see above).
