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
| 3 | Core combat: locking, turrets, missiles, reps, capacitor, reloads, module rack | Done |
| 4 | Webs, scrams, neuts, nosferatu, ECM, damps, tracking disruptors, painters | Done |
| 5 | Real ship models in the fight view | Done, with stand-ins as the fallback |
| 6 | Overheating, drones as targets, scripts, boosters, implants, command bursts | Planned |

Fits are computed with every skill at level V. Both ships start with every module
off, as if they had just undocked.

### What the fight models

- **Locking** by scan resolution and signature radius, lost beyond targeting range.
- **Modules** cycle, use capacitor at the start of each cycle, and finish the
  cycle in progress when switched off. Ammunition runs out and reloads.
- **Turrets**: one roll per shot against tracking and falloff, with the game's
  hit qualities from a glancing blow to a wrecking shot.
- **Missiles** fly for their travel time and apply by explosion radius and
  velocity against the target's signature and speed at impact.
- **Damage** goes through shield, armor and hull with each layer's resists.
  Shields and capacitor recharge along the game's curve.
- **Tank**: armor repairers land at the end of a cycle, shield boosters at the
  start. Ancillary boosters burn charges, ancillary repairers burn paste.
- **Electronic warfare**: webs, scrams (which shut off microwarpdrives),
  dampeners, tracking and guidance disruptors and painters change the target's
  numbers through the fitting engine. Neutralizers and nosferatu move capacitor.
  ECM rolls against sensor strength and breaks the lock.
- **Stats follow the fit**: when a module switches on or off, the fitting engine
  recomputes the ship with exactly what is running and what is being done to it.

Not modelled yet, or simplified:

- Overheating, scripts, boosters, implants and command bursts.
- Drones fight as a flight: they take travel time to reach the target, hit by
  their own tracking, and cannot keep up with a target faster than they are, but
  they cannot be shot at and have no flight path of their own.
- Remote repair and other modules that only make sense with a third ship can be
  seen in the rack but not activated.
- Ranges are measured centre to centre.
- Orbit radius and speed are an approximation that still needs calibrating
  against the game.

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
- `src/sim/` is the simulation: deterministic, no browser APIs, covered by tests.
  `world.ts` is the flight model: ships accelerate toward a wanted velocity
  exponentially, with a time constant of mass x inertia modifier / 1e6 seconds,
  which reproduces in-game align times. `combat.ts` is locking, module cycles,
  capacitor, damage and destruction.
- `src/net/` opens a room. The direct route is WebRTC through
  [PeerJS](https://peerjs.com/): its free public broker introduces the two
  browsers and game traffic then flows straight between them. Many home and
  mobile networks do not allow that, so the host also opens the room on the relay
  (a WebSocket room on the Cloudflare Worker, `worker/src/room.ts`) and a guest
  who cannot get through directly joins there after eight seconds. The fight
  view shows "relayed" beside the room code when that happened. Either way the
  game runs in the host's browser.
- `src/game/` is the session. The host's browser runs the simulation ten times a
  second and sends snapshots; the guest sends orders and commands, which the host
  validates. Each pilot is sent their own ship in full and only the other ship's
  shield, armor and hull. `loadout.ts` asks the fitting engine what each ship is
  worth with the modules that are running and the hostile effects on it.
- `src/arena/` is the fight view. `rig.ts` holds the camera and ship poses,
  `scene.ts` draws stand-in hulls with three.js, `modelView.ts` draws the real
  hulls, `fx.ts` draws weapon fire over either, and `hud.ts` is the interface.

## Ship models

The fight starts on stand-in hulls and switches to the real EVE models once both
have loaded. They are drawn by [ccpwgl2](https://github.com/cppctamber/ccpwgl2)
(MIT), downloaded at build time by `scripts/fetch-ccpwgl2.mjs`, from game files
relayed by a Cloudflare Worker (`worker/`). If the models cannot be loaded, or the
device cannot draw them at a usable frame rate, the stand-ins stay. Players can
also turn real models off on the fit page. Details, findings and the licence
position are in `docs/ship-models.md`.

Module icons come from CCP's image server.

## Licence

The code is GPL-3.0-or-later (see `LICENSE`), because the fitting engine it builds
on is.

EVE Online and all related material are the property of their owner and are used
under the EVE Online Developer License. The game data in `public/sde` is covered by
that licence, not the GPL. This project is not affiliated with or endorsed by the
owner of EVE Online.
