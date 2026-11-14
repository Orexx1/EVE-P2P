# EVE duel sandbox

A free, browser-based sandbox where two EVE Online pilots paste their fits, share a
room code, and fight each other peer to peer. No accounts, no game server.

Inspired by [EVE Combat Sim](https://eve-cs.com/), but deliberately narrower: just
the duel.

## Status

| Step | What it adds | State |
| --- | --- | --- |
| 1 | Paste a fit, see its real stats (defense, damage, capacitor, speed, targeting) | Done |
| 2 | Room codes, peer-to-peer connection, 2D grid, ship movement | Next |
| 3 | Core combat: turrets, missiles, reps, capacitor, reloads | Planned |
| 4 | Webs, scrams, neuts, electronic warfare | Planned |
| 5 | Drones in space, overheating, boosters, implants, command bursts | Planned |

Fits are computed with every skill at level V. Drones are launched automatically up
to the ship's bandwidth.

## Run it

Needs Node 20 or newer.

```bash
npm install
npm run dev      # local site with live reload
npm test         # checks fit numbers against the reference engine
npm run build    # static site in dist/, ready for any web host
```

`dist/` is plain static files. Upload it to any host that serves HTTPS.

## How it works

- `src/fit/` turns pasted EFT text into a computed fit using
  [eve-fit-engine](https://github.com/capsuleers-app/capsuleers.fitting-engine), a
  TypeScript port of pyfa's calculation model that is checked against pyfa.
- `src/data/` loads the game data snapshot. `scripts/sync-sde.mjs` copies it out of
  the engine package into `public/sde` before every dev run and build, so updating
  the game data is `npm update eve-fit-engine`.
- `src/ui/` renders the readout.

## Licence

The code is GPL-3.0-or-later (see `LICENSE`), because the fitting engine it builds
on is.

EVE Online and all related material are the property of their owner and are used
under the EVE Online Developer License. The game data in `public/sde` is covered by
that licence, not the GPL. This project is not affiliated with or endorsed by the
owner of EVE Online.
