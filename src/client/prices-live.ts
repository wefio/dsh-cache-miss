import type { ModelPrice } from './prices.gen'

/**
 * Optional live price catalog.
 *
 * The package ships a models.dev snapshot so a notice line never depends on the
 * network. Prices drift and new models keep appearing, though, and models.dev
 * serves `api.json` with `Access-Control-Allow-Origin: *` — so the page refreshes
 * the DeepSeek subset the first time it meets a model the snapshot cannot price,
 * instead of on a timer or on every release. Everything here is best-effort: the
 * snapshot stays the fallback, a failed or slow fetch changes nothing visible, and
 * a refresh that lands re-renders the lines already on screen.
 */

const SOURCE = 'https://models.dev/api.json'
const PROVIDER = 'deepseek'
const STORAGE_KEY = 'dsh-cache-miss:prices'
const RECORD_VERSION = 1
/** Minimum gap between two refresh attempts for the same page session. */
const MIN_ATTEMPT_INTERVAL_MS = 5 * 60 * 60 * 1000
/** How long a stored catalog stays trusted before the page tries to refresh it. */
const STORED_TTL_MS = 24 * 60 * 60 * 1000

/** One stored catalog, small enough for localStorage (only the DeepSeek subset). */
interface PriceRecord {
  readonly version: number
  readonly fetchedAt: number
  readonly models: Readonly<Record<string, ModelPrice>>
}

/** Catalog refreshed during this page's lifetime; empty until a refresh lands. */
let live: Readonly<Record<string, ModelPrice>> = {}
/** Whether the stored catalog was read; the read happens on first use. */
let loaded = false
/** In-flight refresh, so a render burst starts at most one request. */
let refreshing = false
/** When this page last tried, so an unpriceable model cannot hammer the endpoint. */
let lastAttempt: number | undefined
/** Whether the unavailable-fetch warning was already printed. */
let warned = false
/** Re-render callbacks waiting for a catalog refresh. */
const listeners = new Set<() => void>()

/** Browser storage, when the host page has one. */
function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

/** Read the stored catalog, ignoring anything malformed. */
function readRecord(): PriceRecord | undefined {
  const store = storage()
  if (store === undefined) return undefined
  let raw: string | null
  try {
    raw = store.getItem(STORAGE_KEY)
  } catch {
    return undefined
  }
  if (raw === null) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<PriceRecord>
    if (parsed.version !== RECORD_VERSION) return undefined
    const models = parsed.models
    if (models === null || typeof models !== 'object') return undefined
    if (typeof parsed.fetchedAt !== 'number') return undefined
    return { version: RECORD_VERSION, fetchedAt: parsed.fetchedAt, models: models as Record<string, ModelPrice> }
  } catch {
    return undefined
  }
}

/** Store the refreshed catalog, ignoring quota/security failures. */
function writeRecord(models: Readonly<Record<string, ModelPrice>>, fetchedAt: number): void {
  const store = storage()
  if (store === undefined) return
  try {
    store.setItem(STORAGE_KEY, JSON.stringify({ version: RECORD_VERSION, fetchedAt, models }))
  } catch {
    // Private mode or a full quota: the snapshot still prices every line.
  }
}

/**
 * Whether a refresh attempt is allowed now.
 *
 * @param attemptedAt - when this page last tried, or undefined when it never did.
 * @param now - current time in ms.
 */
export function shouldAttempt(attemptedAt: number | undefined, now: number): boolean {
  return attemptedAt === undefined || now - attemptedAt > MIN_ATTEMPT_INTERVAL_MS
}

/**
 * Whether the stored price data is past its one-day trust window.
 *
 * A stale catalog still prices lines — it is simply no longer authoritative, so
 * the page fetches a fresher one in the background. This is what keeps a reprice
 * from going unnoticed just because the bundled snapshot happens to list the model.
 *
 * @param fetchedAt - when the stored catalog was fetched, or undefined when none.
 * @param now - current time in ms.
 */
export function isStale(fetchedAt: number | undefined, now: number): boolean {
  return fetchedAt === undefined || now - fetchedAt > STORED_TTL_MS
}

/**
 * Extract the DeepSeek price rows from a models.dev catalog.
 *
 * @param text - raw `api.json` body.
 * @returns model id → USD list price (per 1M tokens), or undefined when the body
 *   is not a catalog or has no usable DeepSeek provider.
 */
export function parseCatalog(text: string): Record<string, ModelPrice> | undefined {
  let catalog: unknown
  try {
    catalog = JSON.parse(text)
  } catch {
    return undefined
  }
  if (catalog === null || typeof catalog !== 'object') return undefined
  const provider = (catalog as Record<string, unknown>)[PROVIDER]
  if (provider === null || typeof provider !== 'object') return undefined
  const models = (provider as { models?: unknown }).models
  if (models === null || typeof models !== 'object') return undefined
  const rows: Record<string, ModelPrice> = {}
  for (const [id, model] of Object.entries(models as Record<string, unknown>)) {
    if (model === null || typeof model !== 'object') continue
    const cost = (model as { cost?: unknown }).cost
    if (cost === null || typeof cost !== 'object') continue
    const row = cost as { input?: unknown; output?: unknown; cache_read?: unknown }
    if (typeof row.input !== 'number' || typeof row.output !== 'number') continue
    const cacheRead = typeof row.cache_read === 'number' ? row.cache_read : 0
    if (!Number.isFinite(row.input) || !Number.isFinite(row.output) || !Number.isFinite(cacheRead)) continue
    rows[id] = { input: row.input, output: row.output, cacheRead }
  }
  return Object.keys(rows).length === 0 ? undefined : rows
}

/**
 * Catalog to price with: the refreshed one when this page has one, so a refresh
 * applies to the next render rather than mutating completed output.
 */
export function priceCatalog(): Readonly<Record<string, ModelPrice>> {
  if (!loaded) {
    loaded = true
    live = readRecord()?.models ?? {}
  }
  return live
}

/**
 * Refresh when the stored prices are past their one-day trust window.
 *
 * Called once per plugin apply, so a page picked up after a day starts one
 * background refresh instead of trusting an old catalog indefinitely.
 *
 * @param now - current time in ms, injectable for tests.
 * @returns whether a request was actually started.
 */
export function refreshIfStale(now = Date.now()): boolean {
  if (!isStale(readRecord()?.fetchedAt, now)) return false
  return requestPriceRefresh(now)
}

/** Model the previously rendered line carried, to notice a switch. */
let lastModel: string | undefined

/**
 * Note the model a freshly rendered line carries and refresh when it switched.
 *
 * A switch means the reader is now paying different rates, and the stored catalog
 * may be up to a day old — so this is the second moment the plugin spends a
 * request. The first line of a page only records the model: there is nothing to
 * compare it with yet.
 *
 * @param model - model id from the line's assistant message source.
 */
export function noteModel(model: unknown): void {
  if (typeof model !== 'string' || model === '') return
  const previous = lastModel
  lastModel = model
  if (previous !== undefined && previous !== model) requestPriceRefresh()
}

/**
 * Subscribe to catalog refreshes, so a line that rendered without amounts can
 * render again once the prices arrive.
 *
 * @param listener - called after a refresh lands.
 * @returns unsubscribe function.
 */
export function subscribePrices(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Refresh the stored catalog now, unless this page already tried recently.
 *
 * Never throws and never blocks a render; a failure leaves the bundled snapshot
 * in charge and is reported once.
 *
 * @param now - current time in ms, injectable for tests.
 * @returns whether a request was actually started.
 */
export function requestPriceRefresh(now = Date.now()): boolean {
  if (refreshing) return false
  if (typeof fetch !== 'function') return false
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
  if (!shouldAttempt(lastAttempt, now)) return false
  lastAttempt = now
  refreshing = true
  void (async () => {
    try {
      const response = await fetch(SOURCE, { cache: 'no-cache' })
      if (!response.ok) return
      const models = parseCatalog(await response.text())
      if (models === undefined) return
      live = models
      loaded = true
      writeRecord(models, now)
      for (const listener of listeners) {
        try {
          listener()
        } catch {
          // A broken subscriber must not abort the refresh for the others.
        }
      }
    } catch (error) {
      if (!warned) {
        warned = true
        console.warn('[dsh-cache-miss] price refresh failed; keeping the bundled models.dev snapshot.', error)
      }
    } finally {
      refreshing = false
    }
  })()
  return true
}

