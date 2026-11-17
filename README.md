# LASTSYNC

An offline survival system for blackouts, prolonged outages and infrastructure collapse. Keep it on a Windows PC or a USB drive, set it up while you still have internet, and open it after the internet is gone.

Everything runs on the PC at `http://localhost:8787`. No account, no cloud, no install, no npm dependencies.

## Run it

**Windows (portable ZIP):** download `LASTSYNC-windows.zip` from Releases, unzip, double-click `LASTSYNC.exe`. Your data is kept in the `data` folder next to it, so it travels on a USB drive.

**From source (any OS, Node 22.13+):**

```bash
cd lastsync
npm start
```

Then open http://localhost:8787. Set `LASTSYNC_DATA` to choose where data is stored and `PORT` to change the port.

## What's in it

| Feature | Where | Notes |
| --- | --- | --- |
| Survival dashboard | Home | Search, Ask, Maps, My plan up front; pinned items; readiness score; live help alerts |
| Offline library | Library | 8 bundled guides (water, power, food, first aid, shelter, sanitation, communications, emergency kit) with publisher, date, version and sources. Add your own PDFs, text/markdown files and notes |
| Local search | Search | BM25 ranking with survival synonyms ("cleaning water" finds "disinfecting"). Excerpts with highlights, jumps to the exact section, PDF page, note or pin. Filters by topic, pack and type |
| Ask LASTSYNC | Ask | Answers only from your saved library, with numbered citations. Says so when the library doesn't cover a question. Flags emergencies ("call 911/112/999") |
| Offline maps & GPS | Maps | Built-in world outline; import regional `.mbtiles` maps; pins by category; draw routes or import GPX; USB GPS receivers over Web Serial (NMEA) or device location; "last updated" time |
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

Import raster MBTiles (PNG/JPG/WebP tiles), for example made in QGIS or MapTiler from data you're allowed to use, or received in a pack. Vector (`.pbf`) MBTiles aren't supported yet. Please don't bulk-download tiles from openstreetmap.org: its tile usage policy forbids that.

## Develop

```bash
npm test          # node:test — search, Ask safety, access control, group receipts, pack signatures, NMEA, GPX
npm start
```

Layout: `server/` (zero-dependency Node server: search, ask, packs, maps via built-in `node:sqlite`, group over Server-Sent Events), `web/` (vanilla ES modules, no build step; vendored Leaflet, PDF.js and a QR generator in `web/vendor/`), `content/guides/` (bundled guides as Markdown with front matter), `launcher/` (C# source for `LASTSYNC.exe`).

The Windows ZIP is built by `.github/workflows/lastsync-release.yml` on a Windows runner. It runs the tests, bundles `node.exe`, compiles the launcher, smoke-tests the packaged app and zips it. Push a tag like `lastsync-v1.0.0` to publish a release.

## Not built yet

- Meshtastic radio messaging
- Vector map tiles and offline turn-by-turn routing
- Larger knowledge packs (Wikipedia selections, repair manuals)
- Save for Offline (capture web pages)
- Encrypted document vault
- Code signing for `LASTSYNC.exe` (Windows SmartScreen will warn on first launch)
- An official publisher key in `content/trusted-keys.json` (empty until you create one and sign official packs with it)
