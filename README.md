# LASTSYNC

**Free and open source (MIT).** Every file is in this repository, and every running copy shows the exact commit and file fingerprints it is using on its **Open source** page.

An offline survival system for blackouts, prolonged outages and infrastructure collapse. Keep it on a Windows PC or a USB drive, set it up while you still have internet, and open it after the internet is gone.

Everything runs on the PC at `http://localhost:8787`. No account, no cloud, no install, no npm dependencies.

## Run it

**Windows (portable ZIP):** download `LASTSYNC-windows.zip` from Releases, unzip, double-click `LASTSYNC.exe`. Your data is kept in the `data` folder next to it, so it travels on a USB drive.

**From source (any OS, Node 22.13+):**

```bash
npm start
```

Then open http://localhost:8787. Set `LASTSYNC_DATA` to choose where data is stored and `PORT` to change the port.

## What's in it

| Feature | Where | Notes |
| --- | --- | --- |
| Survival dashboard | Home | Search, Ask, Maps, My plan up front; pinned items; readiness score; live help alerts |
| Offline library | Library | 8 bundled guides (water, power, food, first aid, shelter, sanitation, communications, emergency kit) with publisher, date, version and sources. Add your own PDFs, text/markdown files and notes |
| Offline encyclopedia | Encyclopedia | 64 survival-relevant Wikipedia articles (medicine, water, food, sanitation, shelter, power, navigation & comms, disasters). Download once while online; then read, search and Ask over them with no internet. Phones in a group can read them too. Text CC BY-SA 4.0, image credits kept |
| On-device AI | On-device AI | Three model sizes that run inside the browser on the PC's own graphics chip (WebGPU): **Pocket** (~0.5 GB), **Field** (~0.9 GB), **Command** (~1.2 GB). Downloaded once, then works offline. Ask sends it only the passages it retrieved and it must cite them |
| Survival gear | Gear | 27 items across power, water, medical, comms, light & fire, shelter, food, tools and documents — why you need each, what to look for, rough prices, and an "I have this" tracker with an essentials score that feeds Readiness |
| Installable web app | Get the app | The website installs like an app and keeps working offline in the browser: a service worker caches the app, and "Save for offline use" stores guides, the encyclopedia and your plan. If the server can't be reached, Search and Ask fall back to the saved copies |
| Local search | Search | BM25 ranking with survival synonyms ("cleaning water" finds "disinfecting"). Excerpts with highlights, jumps to the exact section, PDF page, note or pin. Filters by topic, pack and type |
| Ask LASTSYNC | Ask | Answers only from your saved library, with numbered citations. Says so when the library doesn't cover a question. Flags emergencies ("call 911/112/999") |
| Street map & GPS | Maps | MapLibre vector map: streets with names, buildings (3D when tilted), water, parks, places, and emergency places (hospitals, pharmacies, police, fire stations, drinking water, shelters, fuel). Every area you view while online is cached on the PC; **Save this area offline** downloads a town down to street level. Offline it falls back to saved areas, then to a built-in world map. Tools: pins, routes, measure (distance, bearing, walking time), range rings, right-click menu, search across pins/places/streets/lat-lon, follow-GPS, rotate/tilt, layers and legend, USB GPS (NMEA) and device location. Imported `.mbtiles` raster maps still work as overlays |
| Household plan | My plan | Contacts, meeting points (with map locations), responsibilities, grab / go / check-on checklists. Autosaves |
| Printable sheet | My plan › Printable sheet | One page: contacts, meeting points, a small map, checklists and quick facts |
| Packs | Packs | Bundle selected guides, documents, notes, pins, routes and maps into one `.lspack` file for USB sharing. SHA-256 per file, optional Ed25519 publisher signatures, verified offline before install |
| Readiness check | Readiness | What's actually saved: guides, maps, routes, AI model, plan, printout, pack dates, free disk, local network |
| Local group | Group | Laptop hosts an invite-only session on local Wi-Fi; phones join by QR code in the browser. I'm safe / Meet here / I need help / Ping, with optional map location. "Received" shows only after the other device confirms it |
| Status board | Group | Who checked in, when you last heard from them, the current meeting point |
| Outage log | Outage log | What happened, what's been checked, what still needs doing — shared live with the group so someone else can take over |

## Ask and AI models

Ask works with **no model at all**: it finds the best-matching section and quotes it as written, then lists related sections. It deliberately never stitches sentences from different places together, because mixing a bleach dose for surfaces into drinking-water instructions is exactly the kind of mistake that hurts people.

For written answers, connect any OpenAI-compatible model in **Settings**:

- **Offline (recommended):** [Ollama](https://ollama.com) (`http://localhost:11434/v1`), LM Studio (`http://localhost:1234/v1`) or a llama.cpp server (`http://localhost:8080/v1`). These run on the PC and keep working in a blackout.
- **Online:** OpenAI or any compatible API. This stops working when the internet does, and LASTSYNC then falls back to built-in answers.

The model only sees the passages LASTSYNC retrieved. It's told to cite them and to say "My saved sources don't cover this" otherwise.

## Group sessions — how phones connect

The laptop and the phones must be on the same network. A Wi-Fi router keeps working without internet as long as it has power, and a UPS or power bank can run one for hours. With no router, turn on **Mobile hotspot** in Windows. Allow LASTSYNC on private networks when Windows asks.

Browsers only allow GPS on secure (https) pages, so phones on the local `http://` address mark their location by tapping the map instead.

## Security model

- Requests from the PC itself (`localhost`) get the full app. A Host-header check blocks DNS-rebinding, and JSON-only POSTs block cross-site forms.
- Other devices on the network get only the join page, the bundled guides (search, read and Ask), map tiles and the group. They need the invite code (rate-limited) and then an HttpOnly session cookie. They never see notes, the plan, documents or settings.
- A strict Content-Security-Policy is applied: no inline scripts and no external hosts.
- Packs are verified before install: every file's SHA-256 must match, and signed packs must match a trusted publisher key. Tampered or damaged packs are refused.

## Maps

Street map data © OpenMapTiles © OpenStreetMap contributors, served by [OpenFreeMap](https://openfreemap.org) and cached locally; set `LASTSYNC_VECTOR_TILEJSON` to use another OpenMapTiles-compatible source. Map labels use bundled Noto Sans glyphs, so text works offline. The online demo shares one tile cache (capped by `LASTSYNC_MAP_CACHE_MB`, default 2048).


Import raster MBTiles (PNG/JPG/WebP tiles), for example made in QGIS or MapTiler from data you're allowed to use, or received in a pack. Vector (`.pbf`) MBTiles aren't supported yet. Please don't bulk-download tiles from openstreetmap.org: its tile usage policy forbids that.

## Online demo (Replit)

`npm run start:public` runs LASTSYNC as a website so people can try it before downloading. The offline app trusts whoever is sitting at the PC; online there is no such person, so the demo works differently:

- Every visitor gets a **private workspace**, tied to a secret cookie. Visitors never see each other's notes or plans.
- Group invites are links (`/join?ws=…#code=…`). People who open one join that visitor's group as guests and get the same limited access as phones on Wi-Fi.
- Workspaces are deleted after 7 days without use. Uploads are capped (25 MB documents, 100 MB maps and packs, 200 MB per visitor), and new workspaces are rate-limited per IP.
- Connecting an AI model is turned off, because a model address typed by a visitor would let them make the server fetch any URL. Ask uses built-in answers.

**Connect to Replit:** on replit.com choose *Create App → Import from GitHub*, pick `HuffyDev/sync`, and press **Run**. The included `.replit` pulls the latest code and starts the demo on port 8787. To publish, use **Deploy → Reserved VM**, since group sessions keep live connections open. Optional environment variables: `LASTSYNC_TTL_DAYS`, `LASTSYNC_QUOTA_MB`, `LASTSYNC_MAX_WORKSPACES`, `LASTSYNC_DOWNLOAD_URL`.

Replit's disk is reset when the app is redeployed, so demo data is temporary by design.

## Open source

LASTSYNC is released under the [MIT license](LICENSE): use it, copy it, change it and share it, including commercially, as long as the license notice stays with it. Bundled third-party components keep their own licenses (see `web/vendor/NOTICES.txt`).

Every copy — the Windows app, a self-hosted server or the online demo — has an **Open source** page that lists:

- the version and the git commit it is running (linked to that commit on GitHub);
- every source file with its SHA-256 fingerprint, readable in the browser;
- one combined fingerprint for the whole app;
- the only outside services it ever contacts, and when.

To check a running copy against the public code:

```bash
git clone https://github.com/HuffyDev/sync.git
```

```bash
cd sync && git checkout <commit shown on the page> && npm run hashes
```

The last line printed is the combined fingerprint; if it matches the page, the running copy is identical to the public source.

## Develop

```bash
npm test          # node:test — search, Ask safety, access control, group receipts, pack signatures, NMEA, GPX
npm start
```

Layout: `server/` (zero-dependency Node server: search, ask, packs, maps via built-in `node:sqlite`, group over Server-Sent Events), `web/` (vanilla ES modules, no build step; vendored Leaflet, PDF.js and a QR generator in `web/vendor/`), `content/guides/` (bundled guides as Markdown with front matter), `launcher/` (C# source for `LASTSYNC.exe`).

The Windows ZIP is built by `.github/workflows/lastsync-release.yml` on a Windows runner. It runs the tests, bundles `node.exe`, compiles the launcher, smoke-tests the packaged app and zips it. Every push to `main` builds the ZIP as a workflow artifact; push a tag like `v1.0.0` to publish it as a GitHub Release (the demo's Download button points at the latest release).

## Not built yet

- Meshtastic radio messaging
- Offline turn-by-turn routing
- Larger knowledge packs (Wikipedia selections, repair manuals)
- Save for Offline (capture web pages)
- Encrypted document vault
- Code signing for `LASTSYNC.exe` (Windows SmartScreen will warn on first launch)
- An official publisher key in `content/trusted-keys.json` (empty until you create one and sign official packs with it)
