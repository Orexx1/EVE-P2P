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

Done:

- The relay is deployed at `https://eve-p2p-res.dustin-m117.workers.dev`
  (recorded in `src/config.ts`). Cloudflare rebuilds it from `worker/` on every
  push to `main`. Its root path answers; no real resource has been fetched through
  it yet.

Next, in order:

1. **Resource index.** In the GitHub Actions build (which can reach CCP's servers;
   the development sandbox cannot), download the current client's resource index
   and publish it with the site, split into small shards so the browser can look
   up one path cheaply. Each index line reads
   `res:/logical/path,<aa>/<file>,<md5>,<size>,<compressed size>`, and the file
   lives at `https://resources.eveonline.com/<aa>/<file>`, which the relay serves
   as `/r/<aa>/<file>`. Finding the current index: the client build list on
   `binaries.eveonline.com` names `app:/resfileindex.txt` and its address. This
   chain is from documentation and community tools and has not been run yet.
2. **Smoke test in CI.** A job that resolves one hull through the index and the
   relay, renders it with ccpwgl2 in headless Chrome, and uploads a screenshot
   artifact (readable with `gh run download`).
3. **Type to model lookup** from the SDE (type -> graphic -> hull:faction:race).
4. **Swap the space view** to ccpwgl2 behind the same interface as
   `src/arena/scene.ts` (`render`, `project`, `directionAt`, `resize`, `dispose`),
   keeping the stand-in view as the fallback when a model fails to load.

## Open risks

- Phone performance: 6 MB engine plus runtime shader translation (described as
  alpha by the library). May need a lower-quality path or stand-ins on weak phones.
- The loader is in maintenance mode; a later move to CarbonEngineJS is likely.
- First load of each hull pulls several MB of models and textures.
