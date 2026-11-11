# YouTube Autopilot AI

An autonomous YouTube agent that takes one long video and produces finished, publish-ready Shorts:
real FFmpeg renders in 9:16, burned-in captions, thumbnails, SEO metadata, scheduling, and official
YouTube Data API publishing after explicit approval.

Everything in the pipeline is real — no simulated progress, no fake uploads. If a capability is not
configured (for example a Gemini key), the agent says so and falls back to measurable heuristics
rather than inventing scenes, timestamps or transcripts.

---

## What the agent does

1. **Understands the instruction** — free-text commands in the Chat view ("turn this video into five
   Shorts", "find the emotional moments", "show me what is waiting for approval").
2. **Validates the source** — uploaded file, direct authorized media URL, or YouTube link.
   A YouTube URL alone never grants download rights: the agent asks for the original file instead of
   bypassing restrictions.
3. **Analyzes the actual media** — FFprobe metadata, scene-change detection, silence detection, audio
   energy profiling, audio extraction, and Gemini transcription + moment selection when a key is set.
4. **Selects highlights** — Gemini reasoning over the transcript, or an energy/scene heuristic when no
   AI key is configured. Timestamps always come from measured media, never from guesses.
5. **Renders Shorts with FFmpeg** — trim, 9:16 crop with subject-centred framing, burned-in ASS captions,
   loudness balancing, transitions, watermark, opening hook, end card, and H.264/AAC MP4 output.
6. **Generates SEO** — title, description, hashtags, keywords, category, pinned comment, thumbnail text,
   plus a rendered thumbnail image. Metadata is labelled `gemini` or `derived` so its origin is visible.
7. **Waits for approval** — clips stop at `awaiting_approval`. Nothing is published without a final
   preview confirmation.
8. **Publishes through the official API** — Google OAuth, resumable upload, progress tracking, optional
   scheduled publish, and the returned watch URL. Failures are reported, not hidden.

## Automation modes

| Mode | Behaviour |
| --- | --- |
| **A — Auto create** | Analyze and render Shorts with metadata; stop before publishing. |
| **B — Auto create + approval** | Same, then a publishing preview requires explicit confirmation per clip. |
| **C — Scheduled content** | Approve clips, set publish times, and the scheduler publishes them through the API. |

## Architecture

```
server/
  index.js          Express API + static client + media streaming + scheduler
  config.js         Paths, limits, status constants, key detection
  db.js             SQLite schema, migrations, row mapping, notifications, memory
  lib/queue.js      Persistent job queue: parallel workers, retry, pause, resume, cancel
  lib/ffmpeg.js     FFprobe/FFmpeg wrappers: probe, scenes, silence, energy, audio, frames
  lib/render.js     ASS caption builder, Short renderer, thumbnail renderer
  lib/gemini.js     Transcription, moment selection, clip direction, SEO, command parsing
  lib/youtube.js    Google OAuth, channel identity, resumable upload, scheduled publish
  lib/pipeline.js   The autonomous workflow (validate → analyze → select → render → SEO)
  lib/agent.js      Public agent API: projects, chat command center, approval, publishing
client/src/         React dashboard: Dashboard, Projects, Shorts, Short detail, Tasks, Settings, Chat
scripts/e2e.js      End-to-end check that renders real MP4s and asserts the whole flow
```

**Storage.** SQLite (`better-sqlite3`) holds projects, shorts, jobs, job logs, notifications,
preferences, channel tokens and agent memory. Rendered media lives under `DATA_DIR/media/<project>/`
and is served by the app itself (`/api/media/...`), so files are only reachable through the API.

**Background work.** Jobs are persisted before they run, so a restart resumes the queue instead of
losing progress. The queue supports parallel workers (`WORKER_CONCURRENCY`), automatic retry for
transient failures, pause/resume at safe checkpoints, and cancellation that terminates running FFmpeg
processes.

## Running it

```bash
npm install
npm run build     # build the dashboard
npm start         # http://0.0.0.0:3000
```

Requirements: Node 20.19+ and FFmpeg on `PATH` (both `ffmpeg` and `ffprobe`).

### Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (default `3000`). |
| `DATA_DIR` | Database + media directory (default `./data`). |
| `APP_PASSWORD` | Optional single-user gate. When set, the UI asks for it and the API requires it. |
| `GEMINI_API_KEY` | Enables transcription, AI moment selection, clip direction and SEO. Without it the agent uses measurable heuristics and labels metadata `derived`. |
| `GEMINI_MODEL` | Optional model override. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth app for YouTube. |
| `OAUTH_REDIRECT_URI` | Must match the redirect registered in Google Cloud (default `<origin>/api/youtube/callback`). |
| `WORKER_CONCURRENCY` | Parallel rendering jobs (default `2`; keep low on small instances). |
| `FFMPEG_PATH` / `FFPROBE_PATH` | Custom binary locations. |

Keys stay on the server. The browser never receives them.

### Connecting YouTube

1. Create a Google Cloud project, enable **YouTube Data API v3**.
2. Create OAuth 2.0 credentials (Web application) and add `<your origin>/api/youtube/callback` as a
   redirect URI.
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_REDIRECT_URI`, restart, then use
   **Connect YouTube** in the dashboard.

Scopes requested are `youtube.upload` and `youtube.readonly`. Passwords are never requested or stored;
the **Disconnect** action revokes the stored refresh token.

Quotas are real: uploads consume YouTube Data API units and large batches can exhaust the daily quota.
Scheduling respects API rules (a scheduled time must be in the future; private uploads may be scheduled).

## API surface

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness plus integration status. |
| `GET` | `/api/state` | Dashboard snapshot: stats, channel, projects, shorts, jobs, notifications, preferences. |
| `POST` | `/api/projects` | Create a project from an upload (`multipart`) or an authorized source URL. |
| `POST` | `/api/projects/:id/run` | Start (or reuse the in-flight) autonomous run. |
| `POST` | `/api/projects/:id/source` | Attach the authorized original file to a YouTube-linked project. |
| `GET` | `/api/projects/:id` | Project detail with clips and job logs. |
| `POST` | `/api/shorts/:id/approve` | Approve or reject a clip. |
| `POST` | `/api/shorts/:id/rerender` | Apply director effects and re-render. |
| `GET` | `/api/shorts/:id/preview` | Publishing preview (video, title, description, hashtags, visibility). |
| `POST` | `/api/shorts/:id/publish` | Publish; requires `confirm: true`. |
| `GET`/`POST` | `/api/jobs/:id/(pause\|resume\|cancel\|retry)` | Task control. |
| `GET`/`PUT` | `/api/preferences` | Agent memory: duration, caption style, language, aspect ratio, schedule, category, watermark, quality. |
| `POST` | `/api/chat` | Natural-language command center. |
| `GET` | `/api/media/:projectId/shorts/:shortId.mp4` | Stream a rendered clip. |

## Verification

```bash
npm run e2e    # generates a 90s synthetic MP4 and exercises the whole agent over HTTP
npm run build  # dashboard build
npm test       # unit checks
```

`npm run e2e` boots the server against a temporary data directory, uploads a real file, waits for the
worker, and asserts: rendered clips are 720x1280 (or 1080x1920) playable MP4s, thumbnails and SEO
fields exist, clips wait for approval, publishing without confirmation is refused, the preview is
returned, approval is recorded, chat commands produce actions, and the clip streams over HTTP.

## Copyright and safety

* Only media the user owns or is authorized to edit is processed; the upload path requires an ownership
  attestation.
* YouTube download restrictions, DRM and access controls are never bypassed. A YouTube URL creates a
  project that waits for the authorized original file.
* Publishing always requires explicit per-clip confirmation, and defaults to the visibility the user
  selects.
* Tokens and API keys stay server-side; the YouTube account can be disconnected at any time.
