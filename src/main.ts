import '@fontsource/saira-semi-condensed/400.css'
import '@fontsource/saira-semi-condensed/500.css'
import '@fontsource/saira-semi-condensed/600.css'
import './styles.css'
import type { FittingDataset } from 'eve-fit-engine'
import { loadDataset } from './data/dataset'
import { FitError, loadFit } from './fit/loadFit'
import { SAMPLE_FITS } from './fit/samples'
import { renderFit } from './ui/fitView'
import { esc } from './ui/format'

const STORAGE_KEY = 'eve-p2p:last-fit'

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <header class="site-head">
    <h1>EVE duel sandbox</h1>
    <p>Paste a fit to see how it flies. Duels against a friend by room code are being built next.</p>
  </header>
  <main>
    <form class="entry" id="entry">
      <label for="eft">Your fit</label>
      <textarea id="eft" spellcheck="false" autocomplete="off" autocapitalize="off"
        placeholder="[Rifter, My fit]&#10;Damage Control II&#10;..."></textarea>
      <p class="hint">In game: Fitting window, then "Copy to clipboard". In pyfa: Ctrl+C on the fit.</p>
      <div class="actions">
        <button type="submit" id="load" disabled>Load fit</button>
        <span id="status" role="status" aria-live="polite"></span>
      </div>
      <p class="samples">
        Or start from a sample:
        ${SAMPLE_FITS.map((s, i) => `<button type="button" class="link" data-sample="${i}">${esc(s.label)}</button>`).join(' ')}
      </p>
    </form>
    <div class="result" id="result" aria-live="polite">
      <p class="placeholder">The fit's defense, damage, capacitor and speed will show here.</p>
    </div>
  </main>
  <footer class="site-foot">
    <p>
      Free and open source under the GPL-3.0. Fitting math by
      <a href="https://github.com/capsuleers-app/capsuleers.fitting-engine">eve-fit-engine</a>, built on pyfa.
      EVE Online and all related material are the property of their owner, used under the EVE Online
      Developer License; this site is not affiliated with or endorsed by them.
      <span id="data-build"></span>
    </p>
  </footer>`

const form = app.querySelector<HTMLFormElement>('#entry')!
const textarea = app.querySelector<HTMLTextAreaElement>('#eft')!
const loadButton = app.querySelector<HTMLButtonElement>('#load')!
const status = app.querySelector<HTMLSpanElement>('#status')!
const result = app.querySelector<HTMLDivElement>('#result')!
const dataBuild = app.querySelector<HTMLSpanElement>('#data-build')!

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
    const loaded = loadFit(textarea.value, dataset)
    result.innerHTML = renderFit(loaded)
    remember(textarea.value)
  } catch (err) {
    const message =
      err instanceof FitError ? err.message : `Could not read this fit: ${err instanceof Error ? err.message : err}`
    result.innerHTML = `<p class="error" role="alert">${esc(message)}</p>`
    if (!(err instanceof FitError)) console.error(err)
  }
}

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
  try {
    dataset = await loadDataset((done, total) => {
      status.textContent = `Loading game data, ${done} of ${total} files`
    })
  } catch (err) {
    status.innerHTML = `${esc(err instanceof Error ? err.message : String(err))} <button type="button" class="link" id="retry">Try again</button>`
    status.querySelector('#retry')!.addEventListener('click', start, { once: true })
    return
  }
  status.textContent = ''
  dataBuild.textContent = `Game data build ${dataset.version}.`
  loadButton.disabled = false
  if (textarea.value.trim()) show()
}

textarea.value = recall()
void start()
