# Real ship models: findings and plan

Status: decided to use real EVE hull models (2026-11-13). Not built yet. The fight
view currently draws stand-in hulls (`src/arena/scene.ts`, `makeHull`).

## What was found

- **Licence.** The EVE Developer License Agreement covers "Game Data": data, images
  and graphics that CCP *makes available* to developers. Hull models taken from the
  game client are not in that definition, and rights not expressly granted are
  reserved. Using them is therefore outside the licence. The project owner accepted
  that risk; if the rights holder objects, the models come out and the stand-ins
  go back in.
- **Loader.** [ccpwgl2](https://github.com/cppctamber/ccpwgl2) (MIT) is a WebGL
  port of EVE's graphics engine that reads client resources directly (models,
  textures, and the game's DX11 shaders, which it translates at load time). It is
  its own renderer, not a three.js add-on. It is deprecated in favour of
  [CarbonEngineJS](https://github.com/carbonenginejs), which was not yet released
  when this was written. Minified bundle: about 6 MB.
- **Resources.** ccpwgl2 needs a server that answers `res:/...` paths with CORS
  headers. CCP's content servers do not send those headers, so a browser cannot
  load from them directly.

## What it takes

1. **A resource proxy** (the one server-side piece). Given a `res:/` path it looks
   the file up in CCP's resource index, fetches it from CCP's content server,
   adds CORS headers, and caches it. Decided: a Cloudflare Worker (`worker/`),
   deployed by Cloudflare from this repo. The Worker only relays content-addressed
   files (`/r/<aa>/<hash>`) for the sites in `ALLOWED_ORIGINS`; turning a `res:/`
   path into that address is done on the site from an index built at deploy time
   (not built yet).
2. **Type to model mapping.** Ship type id -> graphic id -> model "DNA"
   (hull:faction:race), generated from the SDE at build time into `public/sde`.
3. **A new space view on ccpwgl2** replacing the three.js one: scene, camera,
   ship placement each frame, bracket projection. The simulation, networking and
   HUD do not change.
4. **Verification in CI.** The development sandbox cannot reach CCP's servers, so
   rendering is checked by a GitHub Actions job that loads a hull in a headless
   browser and saves a screenshot.

## Where this stands

Proven (2026-11-13), all in GitHub Actions because the development sandbox cannot
reach CCP's servers:

- **Relay**: `https://eve-p2p-res.dustin-m117.workers.dev` (`src/config.ts`),
  rebuilt by Cloudflare from `worker/` on every push. `/res/<game path>` resolves
  through the index; `/r/<aa>/<file>` serves a content address directly. Only the
  origins in `ALLOWED_ORIGINS` are served.
- **Index**: `scripts/build-res-index.mjs` runs in the site deploy. It reads the
  live build from `binaries.eveonline.com/eveclient_TQ.json`, the build's file
  list, then `resfileindex.txt` and `resfileindex_Windows.txt` (the Windows one
  holds the compiled shaders), and publishes about 123,000 entries as 4096 shards
  under `ri/` on the site. `--grep <regex>` lists matching paths for diagnosis.
- **End-to-end check**: the deploy's `verify-relay` job fetches a real hull file
  through the relay and checks the CORS header.
- **First real hull**: the `Model smoke test` workflow renders an Apocalypse
  (`ab1_t1:amarrbase:amarr`) with ccpwgl2 in headless Chrome and prints a
  screenshot into its log as base64 (`SCREENSHOT_JPEG_BASE64:`), since artifacts
  cannot be downloaded from the sandbox. The hull rendered with no shader errors
  in the last two runs.

Learned the hard way:

- ccpwgl2 cannot be rebuilt from source right now (`@carbonenginejs/runtime` in
  its lockfile is not on npm), so the prebuilt `dist/` at commit `fa3c4db` is
  used as is.
- The game's data gains fields the prebuilt library does not know, and one
  unknown field fails the whole file. They are declared at run time through
  `tw2.GetClass(name).blackReaders` (see `scripts/model-smoke/index.html`, which
  also discovers further unknown fields by guessing strings and reloading).
  Known so far: `EveSOFDataHullController.visibilityGroup` (string).
- The live client ships only `graphics/effect.dx12/` shaders; the library asks
  for `effect.dx11`. The relay falls back to the dx12 file. One run with this
  setup failed with hundreds of "shader translation(s) failed" and drew no hull;
  the two runs after it were clean. Cause unknown, so reliability is not
  established. Older builds' file lists (tried 3470007) are no longer served
  (HTTP 403), so DX11 shaders cannot be taken from an old build.
- The default camera sits inside the hull: call `tny.camera.FitToScreen(ship)`.

Next, in order:

1. Run the smoke test several more times and on two or three other hulls to
   measure how reliable shader translation is.
2. **Type to model lookup** from the SDE (type -> graphic -> hull:faction:race),
   generated at build time.
3. **Swap the space view** to ccpwgl2 behind the same interface as
   `src/arena/scene.ts` (`render`, `project`, `directionAt`, `resize`, `dispose`),
   keeping the stand-in view as the fallback when a model fails to load. The
   library (6 MB) and its two worker files must be served from the site.
4. Try it on a real phone; decide on a low-quality path if it is too slow.

## Open risks

- Phone performance: 6 MB engine plus runtime shader translation (described as
  alpha by the library). May need a lower-quality path or stand-ins on weak phones.
- The loader is in maintenance mode; a later move to CarbonEngineJS is likely.
- First load of each hull pulls several MB of models and textures.
