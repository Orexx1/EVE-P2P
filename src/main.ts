import '@fontsource/saira-semi-condensed/400.css'
import '@fontsource/saira-semi-condensed/500.css'
import '@fontsource/saira-semi-condensed/600.css'
import './styles.css'
import './theme.css'
import type { FittingDataset } from 'eve-fit-engine'
import { cleared, hold, startGuard } from './ui/crashGuard'
import { watchProblems } from './ui/problems'
import { loadDataset } from './data/dataset'
import { FitError, loadFit } from './fit/loadFit'
import { SAMPLE_FITS } from './fit/samples'
import { squadronDamage } from './game/loadout'
import { renderFit } from './ui/fitView'
import { createLobby } from './ui/lobby'
import { esc } from './ui/format'
import { crashNotice } from './ui/graphics'

const STORAGE_KEY = 'eve-p2p:last-fit'

// Before anything else: keep what goes wrong, and find out whether the last visit died and in the middle of what.
watchProblems()
const crashed = startGuard()
const starting = hold('boot')

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <header class="site-head">
    <h1>EVE duel sandbox</h1>
    <p>Paste a fit, then fight it against a friend with a room code: locking, weapons, tank, capacitor and electronic warfare, computed from the real fit.</p>
    <p class="poc" role="note">
      <strong>Proof of concept.</strong> An unofficial, non-commercial fan project. It is not made by, affiliated with,
      sponsored by or endorsed by Fenris Creations (formerly CCP Games). <a href="#about">More</a>
    </p>
  </header>
  <main>
    <p class="crash-note" id="crashNote" role="status" hidden></p>
    <form class="entry" id="entry">
      <label for="eft">Your fit</label>
      <textarea id="eft" spellcheck="false" autocomplete="off" autocapitalize="off"
        placeholder="[Rifter, My fit]&#10;Damage Control II&#10;..."></textarea>
      <p class="hint">In game: Fitting window, then "Copy to clipboard". In pyfa: Ctrl+C on the fit.</p>
      <div class="actions">
        <button type="submit" id="load" disabled>Load fit</button>
        <span id="status" role="status" aria-live="polite"></span>
      </div>
      <span class="cells data-bar" id="dataBar" hidden><span></span></span>
      <p class="samples">
        Or start from a sample:
        ${SAMPLE_FITS.map((s, i) => `<button type="button" class="link" data-sample="${i}">${esc(s.label)}</button>`).join(' ')}
      </p>
      <div id="lobby"></div>
    </form>
    <div class="result" id="result" aria-live="polite">
      <p class="placeholder">The fit's defense, damage, capacitor and speed will show here.</p>
    </div>
  </main>
  <footer class="site-foot" id="about">
    <h2>About this project</h2>
    <p>
      This is a proof of concept: an experiment to see whether a two-player EVE fitting duel can run entirely in the
      browser. It is unfinished, it will have bugs, and its numbers can differ from the game. It may change or go
      offline at any time, and it is provided as is, with no warranty of any kind.
    </p>
    <p>
      It is an unofficial fan project, made by a player in their own time. It is not made by, affiliated with,
      sponsored by, approved by or endorsed by Fenris Creations (formerly CCP Games, CCP hf.) or any of its partners,
      and nothing here should be taken as speaking for them. It is free, carries no advertising, takes no payments or
      donations, and asks for no EVE account or login.
    </p>
    <p>
      EVE, EVE Online and all related names, logos, ships, images and game data are the intellectual property of
      Fenris Creations (formerly CCP Games, CCP hf.), and all rights in them are reserved by their owner. They appear
      here only to describe and illustrate the game for its players. No claim of ownership is made over any of it.
      Game data is used under the EVE Online Developer License.
    </p>
    <p>
      If you represent the rights holder and want something changed or removed, open an issue at
      <a href="https://github.com/Orexx1/EVE-P2P/issues">github.com/Orexx1/EVE-P2P</a> and it will be dealt with promptly.
    </p>
    <p>
      The site's own code is free and open source under the GPL-3.0. Fitting math by
      <a href="https://github.com/capsuleers-app/capsuleers.fitting-engine">eve-fit-engine</a>, built on pyfa.
      <span id="data-build"></span>
    </p>
  </footer>`

const form = app.querySelector<HTMLFormElement>('#entry')!
const textarea = app.querySelector<HTMLTextAreaElement>('#eft')!
const loadButton = app.querySelector<HTMLButtonElement>('#load')!
const status = app.querySelector<HTMLSpanElement>('#status')!
const result = app.querySelector<HTMLDivElement>('#result')!
const dataBuild = app.querySelector<HTMLSpanElement>('#data-build')!

const dataBar = app.querySelector<HTMLElement>('#dataBar')!
const dataFill = dataBar.firstElementChild as HTMLElement

const lobby = createLobby(app.querySelector<HTMLDivElement>('#lobby')!)

let dataset: FittingDataset | null = null

function remember(text: string) {
  try {
    localStorage.setItem(STORAGE_KEY, text)
  } catch {
    // Private browsing or storage disabled: the fit just is not remembered.
  }
}

function recall(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function show() {
  if (!dataset) return
  try {
    const eft = textarea.value
    const loaded = loadFit(eft, dataset)
    result.innerHTML = renderFit(loaded, squadronDamage(loaded, dataset))
    remember(eft)
    lobby.setFit({ eft, fit: loaded, dataset })
  } catch (err) {
    lobby.setFit(null)
    const message =
      err instanceof FitError ? err.message : `Could not read this fit: ${err instanceof Error ? err.message : err}`
    result.innerHTML = `<p class="error" role="alert">${esc(message)}</p>`
    if (!(err instanceof FitError)) console.error(err)
  }
}

// A pasted fit loads straight away: no second tap needed.
textarea.addEventListener('paste', () => setTimeout(() => dataset && textarea.value.trim() && show()))

form.addEventListener('submit', (event) => {
  event.preventDefault()
  show()
})

app.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-sample]')
  if (!button) return
  textarea.value = SAMPLE_FITS[Number(button.dataset.sample)].eft
  show()
  if (!dataset) status.textContent = 'Sample pasted. It will load once the game data is ready.'
})

async function start() {
  status.textContent = 'Loading game data…'
  dataBar.hidden = false
  dataFill.style.width = '0%'
  try {
    dataset = await loadDataset((done, total) => {
      status.textContent = `Loading game data, ${done} of ${total} files`
      dataFill.style.width = `${(done / total) * 100}%`
    })
  } catch (err) {
    status.innerHTML = `${esc(err instanceof Error ? err.message : String(err))} <button type="button" class="link" id="retry">Try again</button>`
    status.querySelector('#retry')!.addEventListener('click', start, { once: true })
    dataBar.hidden = true
    starting()
    return
  }
  status.textContent = ''
  dataBar.hidden = true
  dataBuild.textContent = `Game data build ${dataset.version}.`
  loadButton.disabled = false
  lobby.setData(dataset)
  // After a crash at start-up the remembered fit waits in the box for a tap, and is not worked out unasked.
  if (textarea.value.trim() && crashed?.during !== 'boot') show()
  // Up and quiet for a few seconds: the page has started, whatever stopped it before.
  setTimeout(() => {
    starting()
    cleared('boot')
  }, 4_000)
}

const crashNote = app.querySelector<HTMLElement>('#crashNote')!
crashNote.textContent = crashNotice()
crashNote.hidden = !crashNote.textContent
textarea.value = recall()
void start()
