# Urban Wood Club — Delft tree tracker

Tracks city trees in Delft: what already exists, what's officially slated
for felling or newly planted, and what the public reports seeing on the
ground. First trial scope is Delft only; see the project's
"architecture-and-roadmap" doc (in the Claude project) for the full plan.

## Layout

- `api/` — Cloudflare Worker (Hono). Serves the REST API (`/api/trees`,
  `/api/permits`, `/api/uploads`) and runs the daily ingestion pipeline
  (Cron Trigger) that pulls Tier 1 (municipal tree dataset) and Tier 2
  (national felling-permit announcements). D1 for structured data, R2 for
  uploaded photos.
- `app/` — Vite + React frontend. Map view (MapLibre) rendering the tree
  and permit layers, plus the public photo-upload flow.

## Data sources wired in (see `api/data/sources.md` for details)

- Delft's own managed-tree dataset (ArcGIS open data) — Tier 1 baseline.
- OpenStreetMap tree tags via Overpass — Tier 1b, complementary/cross-check.
- National "Officiële Bekendmakingen" SRU API — Tier 2, felling permits.
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

**Note:** this folder syncs through OneDrive. Git repos (lots of small
files under `.git/`) don't always play nicely with OneDrive's sync — if
you hit slowness or odd file-lock errors, consider moving the repo to a
local, non-synced folder and keeping this OneDrive folder for docs/assets
only.
