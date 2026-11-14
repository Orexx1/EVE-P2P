// The "fight with this fit" controls: create a room, join one by code, or fly solo.
import type { FittingDataset } from 'eve-fit-engine'
import type { LoadedFit } from '../fit/loadFit'
import { cleanPilot, GuestSession, handshake, HostSession, specFor, type Player, type Session } from '../game/session'
import { hostRoom, joinRoom, normaliseCode, type HostedRoom } from '../net/room'

const MODELS_KEY = 'eve-p2p:real-models'

const PILOT_KEY = 'eve-p2p:pilot'

export interface Lobby {
  /** Call whenever the loaded fit changes; null hides the controls. */
  setFit(current: { eft: string; fit: LoadedFit; dataset: FittingDataset } | null): void
}

export function createLobby(host: HTMLElement): Lobby {
  host.innerHTML = `
    <section class="duel" hidden>
      <h2>Fight with this fit</h2>
      <label for="pilot">Pilot name</label>
      <input id="pilot" maxlength="32" autocomplete="nickname" placeholder="Pilot" />
      <div class="duel-choices">
        <div class="duel-row">
          <button type="button" data-act="create">Create a room</button>
          <button type="button" data-act="solo">Fly solo</button>
        </div>
        <label for="code">Or join a friend's room</label>
        <div class="duel-row">
          <input id="code" inputmode="text" autocapitalize="characters" autocomplete="off" spellcheck="false"
            maxlength="8" placeholder="Room code" />
          <button type="button" data-act="join">Join room</button>
        </div>
        <label class="check">
          <input type="checkbox" id="spar" checked />
          Solo practice target fights back
        </label>
        <label class="check">
          <input type="checkbox" id="models" />
          Real ship models (heavier to load; turn off if the fight stutters)
        </label>
      </div>
      <div class="room" hidden>
        <p>Give this code to your opponent:</p>
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
  const status = host.querySelector<HTMLElement>('.duel-status')!
  const pilotInput = host.querySelector<HTMLInputElement>('#pilot')!
  const codeInput = host.querySelector<HTMLInputElement>('#code')!
  const buttons = () => host.querySelectorAll<HTMLButtonElement>('.duel-choices button')

  let current: Parameters<Lobby['setFit']>[0] = null
  let hosted: HostedRoom | null = null
  let attempt = 0

  const modelsInput = host.querySelector<HTMLInputElement>('#models')!
  const readModels = () => {
    try {
      modelsInput.checked = localStorage.getItem(MODELS_KEY) !== 'off'
    } catch {
      modelsInput.checked = true
    }
  }
  try {
    pilotInput.value = localStorage.getItem(PILOT_KEY) ?? ''
  } catch {
    // No storage: the name just is not remembered.
  }
  readModels()
  modelsInput.addEventListener('change', () => {
    try {
      if (modelsInput.checked) localStorage.removeItem(MODELS_KEY)
      else localStorage.setItem(MODELS_KEY, 'off')
    } catch {
      // No storage: models stay on.
    }
  })

  /** Starts loading real hulls now, so they are ready by the time the fight opens. */
  const warm = (...fits: LoadedFit[]) => {
    if (!modelsInput.checked) return
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

  const me = (): Player & { eft: string } => {
    const pilot = cleanPilot(pilotInput.value)
    try {
      localStorage.setItem(PILOT_KEY, pilot)
    } catch {
      // See above.
    }
    return { pilot, eft: current!.eft, fit: current!.fit, spec: specFor(current!.fit) }
  }

  const launch = async (session: Session) => {
    status.textContent = 'Opening the fight…'
    const { launchArena } = await import('../arena/arena')
    reset()
    launchArena(session, (reason) => {
      // The fight turns models off by itself on a device that cannot keep up.
      readModels()
      reset(reason ?? '')
    })
  }

  const fail = (err: unknown) => reset(err instanceof Error ? err.message : String(err))

  async function create() {
    const mine = me()
    const dataset = current!.dataset
    const id = ++attempt
    setBusy(true)
    status.textContent = 'Opening a room…'
    try {
      const opened = await hostRoom()
      if (id !== attempt) return opened.close()
      hosted = opened
      roomCode.textContent = opened.code
      choices.hidden = true
      room.hidden = false
      status.textContent = ''
      const channel = await opened.guest
      if (id !== attempt) return channel.close()
      hosted = null
      status.textContent = `Opponent connected${channel.via === 'relay' ? ' through the relay' : ''}. Exchanging fits…`
      const theirs = await handshake(channel, mine, dataset)
      warm(mine.fit, theirs.fit)
      await launch(new HostSession([mine, { ...theirs, spec: specFor(theirs.fit) }], channel, opened.code, dataset))
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
    const mine = me()
    const dataset = current!.dataset
    const id = ++attempt
    setBusy(true)
    status.textContent = `Joining room ${code}…`
    try {
      const channel = await joinRoom(code, (text) => {
        if (id === attempt) status.textContent = text
      })
      if (id !== attempt) return channel.close()
      status.textContent = `Connected${channel.via === 'relay' ? ' through the relay' : ''}. Exchanging fits…`
      const theirs = await handshake(channel, mine, dataset)
      warm(mine.fit, theirs.fit)
      await launch(new GuestSession([{ ...theirs, spec: specFor(theirs.fit) }, mine], channel, code, dataset))
    } catch (err) {
      if (id === attempt) fail(err)
    }
  }

  function solo() {
    const mine = me()
    const sparring = host.querySelector<HTMLInputElement>('#spar')!.checked
    void launch(new HostSession([mine, { pilot: 'Practice target', fit: mine.fit, spec: { ...mine.spec } }], null, null, current!.dataset, sparring))
  }

  host.addEventListener('click', (event) => {
    const act = (event.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act
    if (!current && act !== 'cancel') return
    if (act === 'create') void create()
    if (act === 'join') void join()
    if (act === 'solo') solo()
    if (act === 'cancel') reset()
  })
  codeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (current) void join()
    }
  })

  return {
    setFit(next) {
      current = next
      if (next) warm(next.fit)
      section.hidden = !next
      if (!next) reset()
    },
  }
}

