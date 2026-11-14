# EVE duel sandbox

> **Proof of concept.** This is an unofficial, non-commercial fan project and an
> experiment, not a finished product. It is **not made by, affiliated with,
> sponsored by, approved by or endorsed by Fenris Creations** (formerly CCP Games,
> CCP hf.), the makers of EVE Online. See [Disclaimer](#disclaimer).

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
| 6 | Graphics options: presets, resolution, frame rate, anti-aliasing, textures, shaders | Done |
| 7 | Extra ships on either side, flown by the computer | Done |
| 8 | Drones and fighter squadrons as craft in space, with a drone window to command them | Done |
| 9 | Fight screen laid out like the game's: status dial, target discs, sorted overview, order buttons, effects drawn between ships | Done |
| 10 | Scenarios against the computer, alone or with a friend on the same side: challenges with set ships, sandboxes in your own | Done |
| 11 | Real models for drones and fighters, bombs and micro jump drives, repair drones | Planned |
| 12 | Overheating, scripts, boosters, implants, command bursts | Planned |

Fits are computed with every skill at level V. Both ships start with every module
off, as if they had just undocked.

### Extra ships

Whoever creates the room (or flies solo) can add up to ten more ships under
"Extra ships" on the fit page: search for a fit or a ship, then tap **+ Ally** or
**+ Enemy**; each tap adds another copy. Fits come from the one currently loaded,
the samples, and every fit loaded on that device before. Any ship in the game can
also be added as an empty hull, which can be shot at but has nothing to shoot
with. The computer flies the extras: each takes the nearest enemy, orbits inside
its weapons' reach, locks, and runs its modules. The fight ends when one side
has no ships left.

### Scenarios

Ready-made fights against the computer, on the front page under the fit. Each
can be flown alone, or with a friend: "With a friend" opens a room, and whoever
joins with the code flies on the same side.

- **Challenges** set every ship, the players' included, so they play the same
  for everyone and need no fit loaded. Flown alone, the computer flies the
  second ship as a wingman. A friend joining a challenge needs no fit either.

  | Challenge | You fly | Against |
  | --- | --- | --- |
  | Frigate brawl | Rifter, Merlin | Incursus, Kestrel |
  | Hot drop | Vendetta, Hurricane | 2 Apocalypse, 2 Hurricane, 2 Drake, 2 Caracal |
  | Outnumbered | Vexor, Vexor | Rifter, Merlin, Incursus, Tristan, Kestrel |
  | Gate camp | Hurricane, Drake | Thorax, Rupture, Caracal, Incursus |
  | Battlecruiser escort | Thorax, Caracal | Hurricane, Merlin |
  | Under the guns | Rifter, Incursus | Apocalypse |

- **Sandbox** scenarios set only the opposition. Each player flies whatever fit
  they have loaded: a firing range of hulls that neither move nor shoot at 5,
  10, 20 and 40 km, a frigate wolfpack, a cruiser gang, a drone cloud, three
  heavy hitters, and a supercarrier.

The scenarios and their fits are in `src/game/scenarios.ts`. A test loads every
fit and checks it has no fitting problems, and plays each challenge through with
the computer flying both sides.

### The fight screen

The screen is laid out the way the game's is, so a pilot knows where to look.

- **Status dial**, bottom centre: shield, armor and hull as three arcs over the
  top, the capacitor as a disc of cells that go dark as it drains, and speed
  along the bottom. The module rack sits beside it, one row per slot type.
- **Overview**, right: everything else on grid, nearest first. A row's marker is
  boxed in yellow while that ship is locking or has locked you, and flashes red
  while it is shooting at you or has a module on you.
- **Selected item**, above the overview: tap a bracket in space or an overview
  row to select it, then Approach, Orbit, Keep at range, Lock, or Look at, which
  centres the camera on it until tapped again.
- **Locked targets**, top: a disc each, ringed with its shield, armor and hull,
  with the modules you have running on it underneath. The one with the turning
  reticle is where modules go when switched on; tap another to change it.
- **Effects between ships** are drawn for as long as they run, each in its own
  colour and shape: webs, scramblers and disruptors, neutralizers and nosferatu,
  jammers, painters, dampeners and tracking disruptors, and a shimmer round a
  ship that is repairing armor, boosting shields or patching hull. Both pilots
  see all of them, as they would on grid.
- **Keys**, with a keyboard: F1 to F8 switch the high slots, Alt+F1 to F8 the mid
  slots and Ctrl+F1 to F8 the low slots. Ctrl+Space stops the ship.

### What the fight models

- **Locking** by scan resolution and signature radius, lost beyond targeting
  range, up to the ship's maximum number of locked targets.
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
- **Drones and fighters** are craft in space, not a number added to the ship's
  damage. See below.

### Drones and fighters

Every drone in the bay and every fighter squadron in a launch tube is its own
thing in the fight. It has a position, a speed, shield, armor and hull, and it
can be locked, webbed and shot down like a ship. A fit lists them the usual way
(`Hammerhead II x5`, `Firbolg II x18`); fighters are sorted into squadrons, one
per launch tube, within the ship's limits for light, support and heavy squadrons.

A ship that carries any gets a drone window on the left of the fight screen:

- **Launch, Engage, Orbit, Recall.** Tap tiles to pick which drones or squadrons
  an order goes to; with none picked it goes to all of them. Engage sends them at
  the active locked target, launching them first if they are still docked. Orbit
  breaks off and circles the ship. Recall brings them home.
- **Go to** sends fighter squadrons to hold beside whatever is selected, without
  attacking it.
- **Aggressive** drones go for whoever attacks the ship or its drones without
  being told to; passive drones wait for an order. With **Focus fire** on, drones
  that choose their own target all choose the same one: the pilot's active target
  if it is attacking, otherwise the attacker nearest the ship.
- **Squadron abilities** are buttons beside each squadron: its guns, a salvo of
  rockets or torpedoes with a limited number of volleys, and a burst of speed
  with a cooldown. Using one on a picked squadron uses it on every picked
  squadron that has it.

What is modelled:

- A ship controls five drones at once, within its bandwidth. The bay can hold
  more, and they can be swapped during the fight.
- Drones close at their full speed, then circle at their orbit speed and range.
  Their guns roll to hit like turrets, with the drone's own tracking against how
  fast the target really crosses its sights. A target that outruns their orbit
  leaves them chasing.
- Drones can only be sent at targets inside the ship's drone control range.
- Sentry drones stay where they are dropped and have to be scooped from within
  2,500 m.
- Web, neutralizer and ECM drones work. Smartbombs hit drones, the ship's own
  included.
- A squadron fights as one craft. Fighter weapons never miss; their damage is
  scaled by the target's signature and speed and by falloff, and by how many
  fighters are left. Every fighter's worth of damage costs the squadron a fighter.
- A microwarpdrive burst multiplies a squadron's speed and its signature for
  20 seconds, then rests for 60. Salvos are rearmed, and shields restored, while
  the squadron refuels in its tube.
- Support squadrons web, neutralize, jam and disrupt. Space superiority fighters
  do a twentieth of their damage to ships and slow drones and fighters.
- Computer-flown ships launch and use everything they carry.

Simplified or taken from outside the fitting data:

- Drones and squadrons are drawn as markers, not models.
- How many volleys a salvo carries and how long one takes to rearm (12 at 4 s for
  light attack squadrons, 6 at 6 s for heavy) and the 60 second cooldown on speed
  bursts are the game's values as best known; the fitting data does not include
  them.
- Refuelling takes the squadron's refuelling time for each fighter still alive.
- Micro jump drives, bombs and kamikaze runs on long-range fighters, and repair,
  mining, salvage, painter, dampener and disruptor drones do nothing yet.
- Lost fighters are not replaced from the hangar. A ship brings at most 25 drones
  and squadrons into a fight.
- When a ship dies, its drones and fighters go with it.

Not modelled yet, or simplified:

- Overheating, scripts, boosters, implants and command bursts.
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
- `src/ui/` renders the readout and the room controls. `src/theme.css` holds the
  look: four signal colours (green yours and ready, red hostile, cyan allies,
  amber working) and the bars of cells used wherever something is loading.
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

Module icons come from the EVE image server.

## Disclaimer

**This is a proof of concept.** It exists to find out whether a two-player EVE
fitting duel can run entirely in the browser. It is unfinished, it has bugs, and
its numbers can differ from the game. It may change or go offline at any time. It
is provided as is, with no warranty of any kind and no promise of support.

**It is unofficial.** It is a fan project made by a player in their own time. It
is not made by, affiliated with, sponsored by, approved by or endorsed by Fenris
Creations (formerly CCP Games, CCP hf.) or any of its partners, and nothing in
this repository or on the site speaks for them.

**It is non-commercial.** It is free, carries no advertising, takes no payments
or donations, and asks for no EVE account or login.

**EVE belongs to its owner.** EVE, EVE Online and all related names, logos,
ships, images and game data are the intellectual property of Fenris Creations
(formerly CCP Games, CCP hf.), and all rights in them are reserved by their owner.
They appear here only to describe and illustrate the game for its players. No
claim of ownership is made over any of it, and the licence below does not cover it.

**Rights holders:** if you represent the owner and want something changed or
removed, please [open an issue](https://github.com/Orexx1/EVE-P2P/issues) and it
will be dealt with promptly.

## Licence

The code written for this project is GPL-3.0-or-later (see `LICENSE`), because the
fitting engine it builds on is. That licence covers this project's own code only.

The game data in `public/sde` is used under the EVE Online Developer License and is
not covered by the GPL. Nothing belonging to Fenris Creations is licensed, or
relicensed, by this repository.
