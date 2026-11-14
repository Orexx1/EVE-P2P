// Where fights start: duel with the loaded fit, join a friend's room by code,
// or pick a scenario and fly it alone or with a friend on the same side.
import type { FittingDataset } from 'eve-fit-engine'
import { loadFit, type LoadedFit } from '../fit/loadFit'
import { SCENARIOS, describeSide, hullOf, pilotFit, scenarioEnemies, type Scenario } from '../game/scenarios'
import { cleanPilot, GuestSession, handshake, HostSession, loadExtras, playerFor, type Extra, type Session, type Setup } from '../game/session'
import { esc } from './format'
import { hostRoom, joinRoom, normaliseCode, type HostedRoom } from '../net/room'
import { getGraphics, mountGraphicsPanel } from './graphics'
import { createRoster } from './roster'

const PILOT_KEY = 'eve-p2p:pilot'

export interface Lobby {
  /** Call once the game data is in: scenarios and joining a room need it, but not a fit. */
  setData(dataset: FittingDataset): void
  /** Call whenever the loaded fit changes; null hides what needs a fit of the player's own. */
  setFit(current: { eft: string; fit: LoadedFit; dataset: FittingDataset } | null): void
}

/** Everything a fight needs before it can open: who flies what, and against what. */
interface Plan {
  setup: Setup
  /** The ship this player flies. */
  mine: { eft: string; fit: LoadedFit }
  /** The computer's ships. */
  extras: Extra[]
  /** Flown alone: the computer takes the friend's seat. */
  wingman: Extra | null
}

function scenarioCard(scenario: Scenario): string {
  const you = scenario.pilots ? scenario.pilots.map(hullOf).join(', ') : 'Your own fit'
  const pips = [1, 2, 3].map((n) => `<i${n <= scenario.difficulty ? ' class="on"' : ''}></i>`).join('')
  return `
    <li class="scenario" data-scenario="${scenario.id}">
      <div class="scenario-head">
        <h4>${esc(scenario.title)}</h4>
        <span class="pips" role="img" aria-label="Difficulty ${scenario.difficulty} of 3">${pips}</span>
      </div>
      <p class="scenario-brief">${esc(scenario.brief)}</p>
      <p class="scenario-sides"><span class="you">${esc(you)}</span> <span class="detail">against</span> <span class="them">${esc(describeSide(scenario.enemies))}</span></p>
      <div class="duel-row">
        <button type="button" data-act="scenario-solo">Fly solo</button>
        <button type="button" data-act="scenario-host">With a friend</button>
      </div>
    </li>`
}

// Easiest first.
const scenarioList = (kind: Scenario['kind']) =>
  SCENARIOS.filter((s) => s.kind === kind)
    .sort((a, b) => a.difficulty - b.difficulty)
    .map(scenarioCard)
    .join('')

export function createLobby(host: HTMLElement): Lobby {
  host.innerHTML = `
    <section class="duel" hidden>
      <h2>Fly</h2>
      <label for="pilot">Pilot name</label>
      <input id="pilot" maxlength="32" autocomplete="nickname" placeholder="Pilot" />
      <div class="duel-choices">
        <div class="own-fit" data-el="own" hidden>
          <h3>Fight with this fit</h3>
          <div id="roster"></div>
          <div class="duel-row">
            <button type="button" data-act="create">Create a room</button>
            <button type="button" data-act="solo">Fly solo</button>
          </div>
          <label class="check">
            <input type="checkbox" id="spar" checked />
            Solo practice target fights back
          </label>
        </div>
        <p class="hint" data-el="noFit">Load a fit above to duel in it, or to take it into a sandbox scenario. Challenges and joining a friend's challenge need no fit.</p>
        <label for="code">Join a friend's room</label>
        <div class="duel-row">
          <input id="code" inputmode="text" autocapitalize="characters" autocomplete="off" spellcheck="false"
            maxlength="8" placeholder="Room code" />
          <button type="button" data-act="join">Join room</button>
        </div>
        <h3>Scenarios</h3>
        <p class="hint">Fly one alone, or open a room and fly it with a friend on your side against the computer.</p>
        <h4 class="scenario-kind">Challenges <span class="detail">every ship is set, yours included</span></h4>
        <ul class="scenarios">${scenarioList('challenge')}</ul>
        <h4 class="scenario-kind">Sandbox <span class="detail">set opposition, in whatever you have loaded</span></h4>
        <ul class="scenarios" data-el="sandbox">${scenarioList('sandbox')}</ul>
        <details class="gfx-fold">
          <summary>Graphics options</summary>
          <div id="gfx"></div>
        </details>
      </div>
      <div class="room" hidden>
        <p data-el="roomFor">Give this code to your opponent:</p>
        <p class="room-code" data-el="roomCode"></p>
        <p class="hint">Waiting for them to join. Keep this page open.</p>
        <button type="button" class="link" data-act="cancel">Close the room</button>
      </div>
      <p class="duel-status" role="status" aria-live="polite"></p>
    </section>`

  const section = host.querySelector<HTMLElement>('.duel')!
  const choices = host.querySelector<HTMLElement>('.duel-choices')!
  const room = host.querySelector<HTMLElement>('.room')!
  const roomCode = host.querySelector<HTMLElement>('[data-el="roomCode"]')!
  const roomFor = host.querySelector<HTMLElement>('[data-el="roomFor"]')!
  const own = host.querySelector<HTMLElement>('[data-el="own"]')!
  const noFit = host.querySelector<HTMLElement>('[data-el="noFit"]')!
  let dataset: FittingDataset | null = null
  const status = host.querySelector<HTMLElement>('.duel-status')!
  const pilotInput = host.querySelector<HTMLInputElement>('#pilot')!
  const codeInput = host.querySelector<HTMLInputElement>('#code')!
  const buttons = () => host.querySelectorAll<HTMLButtonElement>('.duel-choices button')

  let current: Parameters<Lobby['setFit']>[0] = null
  let hosted: HostedRoom | null = null
  let attempt = 0

  try {
    pilotInput.value = localStorage.getItem(PILOT_KEY) ?? ''
  } catch {
    // No storage: the name just is not remembered.
  }
  mountGraphicsPanel(host.querySelector<HTMLElement>('#gfx')!)
  const roster = createRoster(host.querySelector<HTMLElement>('#roster')!)

  /** Starts loading real hulls now, so they are ready by the time the fight opens. */
  const warm = (...fits: LoadedFit[]) => {
    if (!getGraphics().models) return
    void import('../arena/modelView').then((m) => m.warmShips(fits.map((f) => f.fit.shipTypeID))).catch(() => {})
  }

  const setBusy = (busy: boolean) => buttons().forEach((b) => (b.disabled = busy))
  const reset = (message = '') => {
    attempt++
    hosted?.close()
    hosted = null
    room.hidden = true
    choices.hidden = false
    setBusy(false)
    status.textContent = message
  }

  const pilotName = () => {
    const pilot = cleanPilot(pilotInput.value)
    try {
      localStorage.setItem(PILOT_KEY, pilot)
    } catch {
      // See above.
    }
    return pilot
  }

  const launch = async (session: Session, setup: Setup) => {
    session.title = setup.title
    session.brief = setup.brief
    status.textContent = 'Opening the fight…'
    const { launchArena } = await import('../arena/arena')
    reset()
    launchArena(session, (reason) => reset(reason ?? ''))
  }

  const fail = (err: unknown) => reset(err instanceof Error ? err.message : String(err))

  /** A duel in the loaded fit, with whatever extra ships the host added. */
  const duelPlan = (): Plan => ({
    setup: { coop: false, title: '', brief: '' },
    mine: { eft: current!.eft, fit: current!.fit },
    extras: roster.extras(),
    wingman: null,
  })

  /** A scenario: a challenge sets both pilots' ships; a sandbox is flown in the loaded fit. */
  const scenarioPlan = (scenario: Scenario): Plan | null => {
    const given = pilotFit(scenario, 0)
    if (!given && !current) {
      status.textContent = `${scenario.title} is flown in your own ship. Load a fit at the top of the page first.`
      return null
    }
    const friend = pilotFit(scenario, 1)
    return {
      setup: { coop: true, title: scenario.title, brief: scenario.brief, guestEft: friend ?? undefined },
      mine: given ? { eft: given, fit: loadFit(given, dataset!) } : { eft: current!.eft, fit: current!.fit },
      extras: scenarioEnemies(scenario),
      wingman: friend ? { team: 0, pilot: 'Wingman', eft: friend } : null,
    }
  }

  async function create(plan: Plan) {
    const pilot = pilotName()
    const id = ++attempt
    setBusy(true)
    status.textContent = 'Opening a room…'
    try {
      const opened = await hostRoom()
      if (id !== attempt) return opened.close()
      hosted = opened
      roomCode.textContent = opened.code
      roomFor.textContent = plan.setup.coop ? `${plan.setup.title}: give this code to your friend. You fly on the same side.` : 'Give this code to your opponent:'
      choices.hidden = true
      room.hidden = false
      status.textContent = ''
      const channel = await opened.guest
      if (id !== attempt) return channel.close()
      hosted = null
      status.textContent = `${plan.setup.coop ? 'Friend' : 'Opponent'} connected${channel.via === 'relay' ? ' through the relay' : ''}. Exchanging fits…`
      const theirs = await handshake(channel, { pilot, eft: plan.mine.eft, extras: plan.extras, setup: plan.setup }, dataset!)
      const players = [
        playerFor(pilot, plan.mine.fit, 0, false),
        playerFor(theirs.pilot, theirs.fit, plan.setup.coop ? 0 : 1, false),
        ...loadExtras(plan.extras, dataset!),
      ]
      warm(...players.map((p) => p.fit))
      await launch(new HostSession(players, channel, opened.code, dataset!), plan.setup)
    } catch (err) {
      if (id === attempt) fail(err)
    }
  }

  async function join() {
    const code = normaliseCode(codeInput.value)
    if (!code) {
      status.textContent = 'Room codes are 6 letters and numbers, like K7Q2MX.'
      codeInput.focus()
      return
    }
    const pilot = pilotName()
    const id = ++attempt
    setBusy(true)
    status.textContent = `Joining room ${code}…`
    try {
      const channel = await joinRoom(code, (text) => {
        if (id === attempt) status.textContent = text
      })
      if (id !== attempt) return channel.close()
      status.textContent = `Connected${channel.via === 'relay' ? ' through the relay' : ''}. Exchanging fits…`
      // The host's hello says what kind of fight this is, carries any extra ships,
      // and in a challenge gives this player their ship.
      const theirs = await handshake(channel, { pilot, eft: current?.eft ?? '' }, dataset!)
      const setup = theirs.setup ?? { coop: false, title: '', brief: '' }
      const mine = theirs.own ?? current!.fit
      const players = [playerFor(theirs.pilot, theirs.fit, 0, false), playerFor(pilot, mine, setup.coop ? 0 : 1, false), ...theirs.extras]
      warm(...players.map((p) => p.fit))
      await launch(new GuestSession(players, channel, code, dataset!), setup)
    } catch (err) {
      if (id === attempt) fail(err)
    }
  }

  /** A duel flown alone: against the extra ships if any enemies were added, otherwise against a copy of the loaded fit. */
  function solo() {
    const pilot = pilotName()
    const plan = duelPlan()
    const sparring = host.querySelector<HTMLInputElement>('#spar')!.checked
    try {
      const extras = loadExtras(plan.extras, dataset!)
      const target = extras.some((p) => p.team === 1) ? [] : [playerFor('Practice target', plan.mine.fit, 1, true, sparring ? 'fight' : 'passive')]
      void launch(new HostSession([playerFor(pilot, plan.mine.fit, 0, false), ...target, ...extras], null, null, dataset!), plan.setup)
    } catch (err) {
      fail(err)
    }
  }

  /** A scenario flown alone: in a challenge the computer flies the friend's ship as a wingman. */
  function soloScenario(plan: Plan) {
    try {
      const others = loadExtras([...(plan.wingman ? [plan.wingman] : []), ...plan.extras], dataset!)
      void launch(new HostSession([playerFor(pilotName(), plan.mine.fit, 0, false), ...others], null, null, dataset!), plan.setup)
    } catch (err) {
      fail(err)
    }
  }

  host.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    const act = target.closest<HTMLElement>('[data-act]')?.dataset.act
    if (act === 'cancel') return reset()
    if (!dataset || !act) return
    if (act === 'join') return void join()
    const scenario = SCENARIOS.find((s) => s.id === target.closest<HTMLElement>('[data-scenario]')?.dataset.scenario)
    if (scenario && (act === 'scenario-solo' || act === 'scenario-host')) {
      try {
        const plan = scenarioPlan(scenario)
        if (!plan) return
        if (act === 'scenario-solo') soloScenario(plan)
        else void create(plan)
      } catch (err) {
        fail(err)
      }
      return
    }
    if (!current) return
    if (act === 'create') void create(duelPlan())
    if (act === 'solo') solo()
  })
  codeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (dataset) void join()
    }
  })

  return {
    setData(data) {
      dataset = data
      section.hidden = false
    },
    setFit(next) {
      current = next
      roster.setFit(next)
      if (next) warm(next.fit)
      own.hidden = !next
      noFit.hidden = !!next
    },
  }
}
