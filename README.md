# Sub Rosa

A private desktop AI assistant for meeting notes and dictation, powered by
**Carpe Diem**. Record a meeting, get an editable transcript and summary — all
on your Mac. No terminal, no `.env` files: download the app, paste your Carpe
Diem key, and it works.

> Sub Rosa is a rebranded fork of **June** (`open-software-network/os-june`,
> MIT). See [Attribution](#attribution).

---

## For users

1. **Download & install** the latest Sub Rosa build (macOS `.dmg`, Windows
   `.exe`) from the releases page.
2. **Launch it.** On first run, a welcome screen asks for two things:
   - **Base URL** — pre-filled with `https://carpe-diem.xyz/api/operator/v1`.
     Leave it unless you were told otherwise.
   - **API key** — your Carpe Diem key, which looks like `cdm_…`.
3. Click **Save**, then **Test connection** to confirm the key and your credits.
4. Record a meeting → Sub Rosa transcribes it and generates editable notes.

You can change the base URL or key any time in **Settings → Carpe Diem**. Your
key is stored in your operating system's keychain — never in a plaintext file
and never sent anywhere except your local backend.

### Getting a Carpe Diem key

Create a key and add credits in the [Carpe Diem dashboard](https://carpe-diem.xyz).
Carpe Diem is an OpenAI-compatible endpoint (same model catalogue as Venice);
Sub Rosa's defaults — `nvidia/parakeet-tdt-0.6b-v3` for transcription and
`zai-org-glm-5-2` for notes — work out of the box.

---

## How it works

Sub Rosa never talks to model providers directly. It ships a local backend
(`june-api`) as an internal **sidecar**: at launch the app picks a free
loopback port, generates a random bearer token, and starts the sidecar pointed
at Carpe Diem with your key (read from the OS keychain). The desktop client
talks only to `http://127.0.0.1:<port>`. Your recordings, transcripts, and
notes stay on your machine; model inference runs through Carpe Diem's
confidential backend.

Changing the key or base URL in Settings restarts the sidecar automatically.

---

## For developers

Requirements: Node 22+, `pnpm` (via `corepack`), Rust (stable), and the Apple
targets for release builds (`aarch64-apple-darwin`, `x86_64-apple-darwin`).

```sh
corepack enable
pnpm install

# Dev: the app spawns june-api itself. In debug builds you can inject the key
# via env instead of the keychain:
SUBROSA_DEV_API_KEY=cdm_… pnpm tauri:dev

# Production bundle (unsigned locally; CI signs + notarizes):
pnpm tauri:build

# Quality gate
pnpm check && pnpm typecheck && pnpm test && pnpm test:rust && pnpm test:june-api
```

The fork's logic is concentrated in `src-tauri/src/carpe_diem/` (branding,
settings/keychain, and the sidecar manager), `src/lib/branding.ts`, and the
Carpe Diem UI (`src/components/carpe-diem/`, `src/components/settings/CarpeDiemSettings.tsx`).
See [`FORK_NOTES.md`](FORK_NOTES.md) for every file that diverges from upstream
and how to re-merge, and [`HANDOFF.md`](HANDOFF.md) for the signing/updater
secrets a maintainer must provide.

Releases and auto-updates are driven by `.github/workflows/release.yml`
(signed multi-OS build → published to the public `sub-rosa-releases` repo with
a Tauri updater manifest). `.github/workflows/upstream-sync.yml` keeps the fork
tracking upstream June by opening sync PRs.

---

## Attribution

Sub Rosa is based on **June** by Open Software Network
(<https://github.com/open-software-network/os-june>), used under the MIT
License. The original copyright and license are retained in [`LICENSE`](LICENSE),
[`NOTICE`](NOTICE), and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). Sub
Rosa is an independent fork and is not affiliated with or endorsed by Open
Software Network.

## License

MIT — see [`LICENSE`](LICENSE).
