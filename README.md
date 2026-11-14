# EVE duel sandbox

A free, browser-based sandbox where two EVE Online pilots paste their fits, share a
room code, and fight each other peer to peer. No accounts, no game server.

Inspired by [EVE Combat Sim](https://eve-cs.com/), but deliberately narrower: just
the duel.

## Status

| Step | What it adds | State |
| --- | --- | --- |
| 1 | Paste a fit, see its real stats (defense, damage, capacitor, speed, targeting) | Done |
| 2 | Room codes, peer-to-peer connection, 3D space view, ship movement, first HUD | Done |
| 3 | Core combat: locking, turrets, missiles, reps, capacitor, reloads, module rack | Next |
| 4 | Webs, scrams, neuts, electronic warfare | Planned |
| 5 | Drones in space, overheating, boosters, implants, command bursts | Planned |

Fits are computed with every skill at level V. Drones are launched automatically up
to the ship's bandwidth.

Ships are drawn as stand-in hull shapes sized by ship class. Real EVE hull models
are not included: see "Ship models" below.

On phones the fight view only runs in landscape. In portrait it shows a notice asking
the player to turn the phone, and the fight does not start until both players are
in landscape.

## Run it

Needs Node 20 or newer.

```bash
npm install
npm run dev      # local site with live reload
npm test         # checks fit numbers against the reference engine
npm run build    # static site in dist/, ready for any web host
```

`dist/` is plain static files. Every push to `main` tests, builds and publishes it
to GitHub Pages (`.github/workflows/deploy.yml`): https://orexx1.github.io/EVE-P2P/

## How it works

- `src/fit/` turns pasted EFT text into a computed fit using
  [eve-fit-engine](https://github.com/capsuleers-app/capsuleers.fitting-engine), a
  TypeScript port of pyfa's calculation model that is checked against pyfa.
- `src/data/` loads the game data snapshot. `scripts/sync-sde.mjs` copies it out of
  the engine package into `public/sde` before every dev run and build, so updating
  the game data is `npm update eve-fit-engine`.
- `src/ui/` renders the readout and the room controls.
- `src/sim/` is the flight model: deterministic, no browser APIs, covered by tests.
  Ships accelerate toward a wanted velocity exponentially, with a time constant of
  mass x inertia modifier / 1e6 seconds, which reproduces in-game align times.
- `src/net/` opens a room over WebRTC using [PeerJS](https://peerjs.com/). Its free
  public broker introduces the two browsers; game traffic then flows directly
  between them.
- `src/game/` is the session. The host's browser runs the simulation ten times a
  second and sends snapshots; the guest sends orders. Each side computes both fits
  locally from the pasted text.
- `src/arena/` is the fight view: a three.js scene drawn relative to the player's
  ship, and the HUD.

## Ship models

Real hull models are in progress: see `docs/ship-models.md`. A Cloudflare Worker
(`worker/`) relays the game's files to the browser, and a CI smoke test already
renders a real hull through it. The fight view still uses the stand-ins
(`src/arena/scene.ts`, `makeHull`) until the model view replaces them.

## Licence

The code is GPL-3.0-or-later (see `LICENSE`), because the fitting engine it builds
on is.

EVE Online and all related material are the property of their owner and are used
under the EVE Online Developer License. The game data in `public/sde` is covered by
that licence, not the GPL. This project is not affiliated with or endorsed by the
owner of EVE Online.
