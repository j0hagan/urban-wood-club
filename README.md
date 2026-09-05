# Urban Wood Club — Delft tree tracker

Tracks city trees in Delft: what already exists, what's officially slated
for felling or newly planted, and what the public reports seeing on the
ground. First trial scope is Delft only; see the project's
"architecture-and-roadmap" doc (in the Claude project) for the full plan.

## Layout

- `api/` — Cloudflare Worker (Hono). Serves the REST API (`/api/trees`,
  `/api/permits`, `/api/reports`) and runs the daily ingestion pipeline
  (Cron Trigger) that pulls Tier 1 (municipal tree dataset) and Tier 2
  (national felling-permit announcements). D1 for structured data, R2 for
  reported photos.
- `app/` — Vite + React frontend. Map view (MapLibre) rendering the tree
  and permit layers, plus the "Witness a Tree" report wizard (matches
  urbanwood.club's Capture/Location/Details flow).

## Data sources wired in (see `api/data/sources.md` for details)

- Delft's own managed-tree dataset — Tier 1 baseline. Pulled through the
  ArcGIS Hub v3 downloads API (confirmed live, real data - species,
  planting year, neighborhood).
- OpenStreetMap tree tags via Overpass — Tier 1b, complementary/cross-check.
- National "Officiële Bekendmakingen" SRU API — Tier 2, felling permits
  (field names against a live response still unverified).
- Tier 3 (tree removals buried inside larger construction/infra permits)
  and the Bomenwacht viewer (pending — looks like a private/client dataset,
  not yet confirmed as usable) are not wired up yet.

## Getting this running

This was scaffolded without network access, so nothing has been installed
or tested yet. From a normal terminal (not this sandboxed one):

```
cd api && npm install
cd ../app && npm install
```

You'll need your own Cloudflare account for the rest:

```
npx wrangler login
npx wrangler d1 create urban-wood-club          # then paste the database_id into api/wrangler.jsonc
npx wrangler r2 bucket create urban-wood-club-photos
npx wrangler d1 execute urban-wood-club --file=api/src/db/schema.sql
```

Then push this to a new GitHub repo (`gh repo create` or via github.com),
and connect it to Cloudflare Pages/Workers for deploys.

### Loading the first real data

Cron Triggers don't fire on demand from `wrangler dev`, so there are two
manual endpoints for pulling data in without waiting for the daily
schedule. Set an admin secret first (any string you pick):

```
npx wrangler secret put ADMIN_TOKEN   # for local dev, put it in api/.dev.vars instead:
                                       # echo 'ADMIN_TOKEN=whatever-you-picked' > api/.dev.vars
```

Then, with `wrangler dev` running:

```
curl -X POST http://127.0.0.1:8787/api/admin/sync/trees   -H "Authorization: Bearer whatever-you-picked"
curl -X POST http://127.0.0.1:8787/api/admin/sync/permits -H "Authorization: Bearer whatever-you-picked"
```

The first should pull in Delft's real managed-tree dataset (several
thousand rows) and the map's green layer should populate. The second
pulls recent Delft felling-permit announcements, but they land as
`review_status = 'pending'` - approve them manually for now to see them
on the map:

```
curl http://127.0.0.1:8787/api/admin/permits/pending -H "Authorization: Bearer whatever-you-picked"
curl -X POST http://127.0.0.1:8787/api/admin/permits/<id>/review \
  -H "Authorization: Bearer whatever-you-picked" -H "Content-Type: application/json" \
  -d '{"status":"approved"}'
```

Same pattern for reports submitted through the wizard:
`/api/admin/reports/pending` and `/api/admin/reports/<id>/review`.

**Note:** this folder syncs through OneDrive. Git repos (lots of small
files under `.git/`) don't always play nicely with OneDrive's sync — if
you hit slowness or odd file-lock errors, consider moving the repo to a
local, non-synced folder and keeping this OneDrive folder for docs/assets
only.
