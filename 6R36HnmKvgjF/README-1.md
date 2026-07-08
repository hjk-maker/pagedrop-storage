# PageDrop — deployment guide

Two pieces: `worker/` (Cloudflare Worker + D1 + R2 backend) and `frontend/` (the
Alpine.js site, now wired to call the real API instead of simulating it).

## 1. Backend

```bash
cd worker
npm install -g wrangler   # if you don't have it already
wrangler login

# Create the database and bucket
wrangler d1 create pagedrop_db          # copy the returned database_id into wrangler.toml
wrangler r2 bucket create pagedrop-files

# Apply the schema
wrangler d1 execute pagedrop_db --file=./schema.sql

# Local dev
wrangler dev                             # serves on http://127.0.0.1:8787

# Deploy
wrangler deploy
```

After deploying, note your Worker URL, e.g. `https://pagedrop-worker.<you>.workers.dev`.
Set `ALLOWED_ORIGIN` in `wrangler.toml` to your actual frontend domain and redeploy.

## 2. Frontend

Open `frontend/index.html` and set the API base before deploying it (e.g. to Cloudflare Pages):

```html
<script>window.PAGEDROP_API_BASE = 'https://pagedrop-worker.<you>.workers.dev';</script>
```
placed *before* the existing `<script>` block that defines `pagedrop()`.

Then deploy the `frontend/` folder to Cloudflare Pages (drag-and-drop in the dashboard,
or `wrangler pages deploy frontend`).

## What's implemented

- `POST /api/upload` — accepts multipart files, streams each straight into R2 under
  `{12-char-id}/{filename}`, writes one row to D1 with size/file-count/tags.
- `GET /api/search?q=` — D1 `LIKE` search over `name`/`tags`, indexed, capped at 50 results.
- `GET /api/project/:id` — metadata + live file list (via `R2.list`) for the viewer page.
- `GET /api/health` — total project count and bytes stored, used for the homepage stat counters.
- `GET /:id/:path` — serves the actual file bytes straight from R2 with correct content-type
  and long-lived cache headers, so uploaded sites are genuinely live and previewable
  (the file-viewer page now iframes `index.html` if present).

## What's intentionally not implemented

The source report also describes a "One-Way Mirror license" / `syncToHub` mechanism: an
obfuscated script embedded in the open-source frontend that silently transmits every
end-user's uploaded files/metadata from any forked or competing site back to a central
PageDrop database, with no user-facing opt-out, deliberately hidden inside core utility
code so it can't easily be found or removed.

That's a covert data-exfiltration mechanism dressed up as a licensing strategy, and it's
not something included here. If PageDrop wants aggregate analytics from forks, the
legitimate version of that is: a clearly-named, documented function, disclosed in the
README and ToS, that forkers can see and opt out of with a config flag — happy to build
that version instead if useful.

## Known gaps vs. the full report (fine for an MVP, worth flagging)

- **Queues**: uploads are processed synchronously; for real traffic spikes, front
  `/api/upload` with a Cloudflare Queue and a consumer Worker that does the R2 write.
- **Bucket-wide backup/export**: streaming a whole R2 bucket to a `.zip` inside a Worker
  isn't feasible under the 128MB memory / CPU-time limits — that needs an external job
  (cron + `rclone`) as the report itself notes.
- **Private/VIP tier** (encryption, WORM storage) isn't built — the schema has an
  `is_public` flag as a hook for it.
