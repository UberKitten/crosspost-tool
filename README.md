# Crosspost

A self-hosted web app for crossposting to Bluesky and Mastodon-compatible fediverse servers (Iceshrimp.NET, Mastodon, Akkoma, etc).

Not a scheduler or social media manager. Just a clean posting interface with thread support and platform targeting.

## Features

- **Dual-platform posting** — Bluesky, Fedi, or both. One compose box, pick your targets.
- **Thread composer** — Build multi-post threads from scratch. Each entry gets its own text and images. Platform settings apply to the whole thread.
- **Images** — Paste, drag-drop (anywhere on the page), or file picker. Up to 4 per post. Reorder with drag or arrows. Click to preview in lightbox.
- **AI alt text** — Generate alt text via the Anthropic API or Claude CLI. Editable inline or in the lightbox. Cancellable.
- **Platform-specific settings** — Bluesky: who can reply (threadgate), content labels. Fedi: visibility, content warnings. Collapsible, highlighted when non-default, greyed out when the platform isn't targeted.
- **Link cards** — URLs in posts without images auto-generate Bluesky link preview cards with OG metadata and thumbnails.
- **Drafts** — Auto-saves to the server as you type. Persist across refresh and tabs. Stash drafts (like `git stash`) and restore them later.
- **Scheduling** — Pick a date/time, posts fire from a background worker.
- **Thread continuation** — Reply to your own posts. The app tracks platform-specific IDs and threads correctly on each platform.
- **Timeline** — See everything you've posted, filter by platform, view threads, retry failures, delete locally.
- **PWA** — Installable on mobile via "Add to Home Screen".

## Setup

### 1. Clone and install

```bash
git clone https://github.com/UberKitten/crosspost-tool.git
cd crosspost-tool
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Required | Description |
|---|---|---|
| `BLUESKY_HANDLE` | Yes | Your Bluesky handle (e.g. `you.bsky.social`) |
| `BLUESKY_APP_PASSWORD` | Yes | [App password](https://bsky.app/settings/app-passwords) (not your main password) |
| `FEDI_INSTANCE_URL` | Yes | Your instance URL (e.g. `https://mastodon.social`) |
| `FEDI_ACCESS_TOKEN` | Yes | OAuth token — run `./setup-fedi-auth.sh` to generate |
| `FEDI_CLIENT_ID` | For reauth | Saved by `setup-fedi-auth.sh` |
| `FEDI_CLIENT_SECRET` | For reauth | Saved by `setup-fedi-auth.sh` |
| `FEDI_CHAR_LIMIT` | No | Fedi character limit (default: 3000) |
| `ANTHROPIC_API_KEY` | No | For AI alt text via API. Falls back to Claude CLI if not set. |
| `PORT` | No | Server port (default: 3000) |

#### Fedi auth

The included script handles the OAuth flow:

```bash
./setup-fedi-auth.sh
```

It registers an app, opens the authorization page in your browser, and saves the token to `.env`.

### 3. Run

```bash
npm start
```

Or with Docker:

```bash
docker compose up --build
```

The app is available at `http://localhost:3000`.

## Image handling

Images are stored at full resolution with EXIF/GPS metadata stripped. At post time, they're compressed per-platform:

| Platform | Max size | Max dimension |
|---|---|---|
| Bluesky | 1 MB | 2000px |
| Fedi | 10 MB | 4096px |

Aspect ratios are preserved and sent to Bluesky so images display correctly (no square cropping).

## AI alt text

Alt text generation requires one of:

1. **Anthropic API key** (`ANTHROPIC_API_KEY` in `.env`) — uses the API directly with vision. Faster, works in Docker.
2. **Claude CLI** — falls back to `claude` command if installed and authenticated on the host. Requires [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

If neither is available, alt text generation is disabled (you can still write it manually).

## Tech stack

- **Backend**: Node.js, Express 5, better-sqlite3
- **Frontend**: Vanilla JS SPA (no build step)
- **Platforms**: @atproto/api (Bluesky), Mastodon API (Fedi)
- **Images**: sharp (resize, metadata strip, compression)
- **Container**: Single Dockerfile, single port, SQLite file

## License

[MIT](LICENSE)
