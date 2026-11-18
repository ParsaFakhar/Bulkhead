'use strict'
// Bulkhead TZ — timezone matching wiring.zonelib (zones.js) owns every
// derivation rule and installTZRealm (tz-realm.js) owns the page-realm
// patch; this file's job is delivery: work out which zone each context
// should present, and get the engine into that context's pages before any
// page script runs.
//
// THE DELIVERY MECHANISM, and why it is not a userscript's:
// browser.contentScripts.register() with world:'MAIN', runAt:'document_start'
// and a cookieStoreId filter — one registration per managed context, the zone
// baked into the registered code. Consequences, each of which was a failure
// mode of the userscript this replaces:
//
//   - MAIN world: the engine runs in the page's own realm. No Xray wrappers,
//     no exportFunction seams, no unsafeWindow — patched functions ARE page
//     functions, which is what the toString disguise and CreepJS's lie
//     checks require. (Firefox 128+; BCD: contentScripts.register.world=128,
//     .cookieStoreId=97, .matchOriginAsFallback=128.)
//   - document_start by the platform: injection happens before the document
//     parses, guaranteed. The userscript's late-injection failure (page
//     captured Date before the patch existed, rendering the real zone even
//     though the realm later measured clean) cannot occur here — there is no
//     manager delivery pipeline to lose a race with.
//   - Exempt from page CSP and iframe sandbox (Firefox 128 release notes):
//     strict-CSP sites are patched exactly like any other.
//   - The zone arrives synchronously, resolved: it is a string literal in
//     the registered code. No veil, no cold-start sprint, no corrective
//     reload, no geo-IP request from the page — none of the userscript's
//     resolution machinery is needed, because the extension already knows
//     the answer from a better source (below).
//
// WHERE THE ZONE COMES FROM — and why it is stronger than any page-side
// lookup: the killswitch's own health probe fetches am.i.mullvad.net/json
// THROUGH the container's SOCKS relay, token-routed, and verifies the exit
// hostname before believing a word of it. That answer names the country and
// city of the very IP the container's pages use. zonelib maps it to an IANA
// zone offline, from tzdb's own tables. And because the gate blocks every
// request until a probe succeeds, no page in a managed container can load
// before that answer exists — the fail-closed killswitch turns out to be a
// fail-accurate timezone oracle: the zone is known, verified and registered
// before the first document is allowed to start.
//
// Unmanaged contexts are never spoofed from a probe or a relay listing —
// there is no exit of ours to match, and a zone your real IP contradicts is
// a louder signal than an honest one. Two things still apply there: a user
// pin (a standing instruction, with the UI saying plainly that a pin without
// an exit is a claim the network will not back up), and — when the user says
// a downstream proxy is ON for that context — the page-path exit lookup,
// which measures where pages REALLY surface even when Bulkhead routes
// nothing. In managed contexts the same lookup outranks the probe whenever
// it is on: with FoxyProxy chaining a residential exit after Bulkhead's
// server, the probe can answer from the server while pages leave from the
// residential — and the zone must match the pages' exit, not the probe's.

/* global zonelib, installTZRealm, log */

;(function (root) {
  /** @type {Map<string, { zone: string, handle: { unregister(): Promise<void> } }>} */
  const registered = new Map()
  /** Per-context serialisation: sync() can be called from probe bursts and
   *  storage events at once; registration order per context must not interleave. */
  /** @type {Map<string, Promise<unknown>>} */
  const chains = new Map()
  /** @type {Map<string, TzDerivation>} */
  const derived = new Map()

  let enabled = true
  let reloadOnChange = false
  /** @type {Record<string, string>} mode keyword ('off'|'bulkhead'|'exit') or a pinned zone */
  let overrides = Object.create(null)
  /** @type {Record<string, boolean>} per-context "a downstream proxy (FoxyProxy) is ON" */
  let foxy = Object.create(null)
  /** @type {boolean | null} null = untested, true/false = world:'MAIN' registration capability */
  let mainWorldOk = null
  let lastError = ''
  /** Supplies the page-path exit geo for a context (background owns the lookup).
   *  @type {(id: string) => { country: string | null, city: string | null } | null} */
  let pageGeoSource = () => null
  /** @param {(id: string) => { country: string | null, city: string | null } | null} fn */
  function setPageGeoSource (fn) {
    if (typeof fn === 'function') pageGeoSource = fn
  }

  /* ---------------------------------------------------------------- storage */

  // The first probe can fire (and markHealth -> sync with it) before the
  // startup settings read completes. Rather than let that race install a
  // zone under default settings — wrong whenever the user switched matching
  // off or pinned something — every sync waits on the same one-shot read.
  /** @type {Promise<void> | null} */
  let settingsReady = null

  async function loadSettings () {
    const s = await browser.storage.local.get(['tzEnabled', 'tzOverrides', 'tzReload', 'tzFoxy'])
    enabled = s.tzEnabled !== false
    reloadOnChange = s.tzReload === true
    const ov = s.tzOverrides
    overrides = ov && typeof ov === 'object' ? ov : Object.create(null)
    const fx = s.tzFoxy
    foxy = fx && typeof fx === 'object' ? fx : Object.create(null)
  }

  /** @returns {Promise<void>} */
  function ensureSettings () {
    if (!settingsReady) {
      settingsReady = loadSettings().catch((e) => {
        settingsReady = null // a failed read must be retryable, not latched
        throw e
      })
    }
    return settingsReady
  }

  /* ---------------------------------------------------------------- payload */

  /**
   * The registered code: the realm engine, serialised, with the zone baked
   * in. installTZRealm receives a reference to itself so its worker shims can
   * regenerate the same payload inside worker realms.
   * @param {string} zone
   * @returns {string}
   */
  function payload (zone) {
    const cfg = {
      timeZone: zone,
      // deep: capture about:blank/srcdoc probe realms at insertion time and
      // disguise this engine's own functions to Function.prototype.toString
      // in every realm reached — this is what clears CreepJS's lie marks,
      // since it inspects patched prototypes with a probe iframe's toString.
      stealth: 'deep',
      // all: shim http(s) workers too (blob/data inline workers always).
      workerMode: 'all',
      serviceWorkerMode: 'warn',
      debug: false
    }
    // The late-arrival stamp cannot happen with platform document_start
    // injection, but the engine's own contract says never trust install() —
    // so the check stays, cheap and honest, and verify surfaces it.
    return '(function () {\n'
      + '"use strict";\n'
      + 'var LATE = (function () { try { if (document.readyState && document.readyState !== "loading") return true; '
      + 'return !!(document.scripts && document.scripts.length) } catch (e) { return false } })();\n'
      + 'if (LATE && window === window.top) console.warn("[bulkhead-tz] injected after page scripts ran; reload for a clean install");\n'
      + '(function (__tzl, __cfg) { __tzl(__cfg, __tzl); })(' + installTZRealm.toString() + ', ' + JSON.stringify(cfg) + ');\n'
      + 'try { Object.defineProperty(window, "__bhtz", { configurable: true, value: { zone: ' + JSON.stringify(zone)
      + ', late: LATE, at: Date.now() } }) } catch (e) {}\n'
      + '})();'
  }

  /* ----------------------------------------------------------- registration */

  /**
   * One registration, with defensive option laddering: matchOriginAsFallback
   * (128+, covers about:blank/srcdoc/blob frames by inherited origin) first,
   * matchAboutBlank (52+) if the engine rejects the modern key, and the bare
   * minimum last. world:'MAIN' is NOT laddered away: an isolated-world
   * fallback would deliver Xray-wrapped half-measures that fail lie
   * detection — worse than not patching, because it looks patched. If MAIN
   * is unavailable the feature reports itself unavailable instead.
   * @param {string} id cookieStoreId
   * @param {string} zone
   */
  async function registerZone (id, zone) {
    /** @type {browser.contentScripts.RegisteredContentScriptOptions} */
    const base = {
      matches: ['*://*/*'],
      js: [{ code: payload(zone) }],
      runAt: 'document_start',
      allFrames: true,
      cookieStoreId: [id],
      world: 'MAIN'
    }
    const attempts = [
      { ...base, matchOriginAsFallback: true },
      { ...base, matchAboutBlank: true },
      base
    ]
    let err
    for (const opts of attempts) {
      try {
        const handle = await browser.contentScripts.register(opts)
        mainWorldOk = true
        return handle
      } catch (e) {
        err = e
        // A rejection that names the world option means MAIN is unavailable
        // on this engine; nothing below can fix that, and the ladder must
        // not silently degrade to a detectable half-patch.
        if (/world/i.test(String(e && e instanceof Error ? e.message : e))) break
      }
    }
    mainWorldOk = mainWorldOk === true ? true : false
    throw err instanceof Error ? err : new Error(String(err))
  }

  /** @param {string} id */
  async function unregisterZone (id) {
    const cur = registered.get(id)
    if (!cur) return
    registered.delete(id)
    try {
      await cur.handle.unregister()
    } catch (e) {
      log('[bulkhead-tz] unregister failed for', id, String(e))
    }
  }

  /**
   * Bring one context's registration in line with what it should present.
   * Idempotent: re-syncing an unchanged zone touches nothing.
   * @param {string} id cookieStoreId
   * @param {ContainerConfig | undefined} config live assignment, if any
   * @returns {Promise<{ zone: string | null, source: string, changed: boolean }>}
   */
  async function sync (id, config) {
    const prev = chains.get(id) || Promise.resolve()
    const next = prev.then(async () => {
      await ensureSettings()
      const want = zonelib.derive({
        enabled,
        override: Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : null,
        geo: config ? config.lastGeo || null : null,
        // Exit-mode geography is the OBSERVED exit, trusted once the probe's
        // route was verified — independent of the Mullvad-only health verdict,
        // so a real non-Mullvad exit still gets its zone matched even though the
        // gate blocks it. (lastGeoVerified is set by setGeo only on a verified
        // route; it replaces the old health==='up' gate on geography.)
        geoTrusted: Boolean(config && config.lastGeo && config.lastGeoVerified),
        // Downstream-proxy exit, measured through the container's page path.
        foxyGeo: foxy[id] === true ? (pageGeoSource(id) || null) : null,
        config: config || null,
        intl: Intl
      })

      if (want.zone) {
        derived.set(id, { zone: want.zone, source: want.source, approx: want.approx, rule: want.rule, at: Date.now() })
      } else {
        derived.delete(id)
      }

      const cur = registered.get(id)
      if (!want.zone) {
        const changed = Boolean(cur)
        await unregisterZone(id)
        if (changed) log(`[bulkhead-tz] ${id}: unregistered (${want.source})`)
        return { zone: null, source: want.source, changed }
      }
      if (cur && cur.zone === want.zone) {
        return { zone: want.zone, source: want.source, changed: false }
      }

      const changedZone = cur ? cur.zone : null
      try {
        await unregisterZone(id)
        const handle = await registerZone(id, want.zone)
        registered.set(id, { zone: want.zone, handle })
        lastError = ''
        log(`[bulkhead-tz] ${id}: ${want.zone} via ${want.source}${want.approx ? ' (approx)' : ''} — ${want.rule}`)
        if (changedZone && changedZone !== want.zone && reloadOnChange) {
          reloadContextTabs(id)
        }
        return { zone: want.zone, source: want.source, changed: true }
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
        // Fail loud, fail visible: pages in this context now run with the
        // machine's real zone while the container's exit says otherwise —
        // exactly the inconsistency this feature exists to remove. The
        // popup and options page surface tz.error rather than pretend.
        log('[bulkhead-tz] registration FAILED for', id, lastError)
        return { zone: null, source: want.source, changed: false }
      }
    }, () => undefined)
    chains.set(id, next)
    // The chain must stay alive for later syncs even if this one rejected.
    next.catch(() => {})
    return next.then(
      r => r || { zone: null, source: 'unknown', changed: false },
      () => ({ zone: null, source: 'unknown', changed: false })
    )
  }

  /** @param {string} id */
  async function drop (id) {
    derived.delete(id)
    await unregisterZone(id)
  }

  /**
   * Called after hydrate(): prune registrations for contexts that are gone,
   * sync the rest. Registrations do not survive a browser restart (they live
   * as long as the page that registered them — the persistent background),
   * so on startup this rebuilds the whole set from assignments + overrides.
   * @param {Record<string, ContainerConfig>} containers
   */
  async function rehydrate (containers) {
    for (const id of [...registered.keys()]) {
      if (!(id in containers) && !Object.prototype.hasOwnProperty.call(overrides, id) && foxy[id] !== true) await drop(id)
    }
    // Contexts we owe a derivation even without an assignment: pins, and
    // downstream-proxy contexts whose exit is learned from the page path.
    const extra = new Set([...Object.keys(overrides), ...Object.keys(foxy)])
    for (const id of extra) {
      if (!(id in containers)) await sync(id, undefined).catch(() => {})
    }
    await Promise.all(Object.entries(containers).map(([id, c]) => sync(id, c).catch(() => {})))
  }

  /* -------------------------------------------------------------- overrides */

  /**
   * Store a mode or a pin. The value domain (backward compatible with the
   * original pin/'off' storage):
   *   'off'       never spoof here.
   *   'bulkhead'  match the ASSIGNED Bulkhead server's listed location only,
   *               deliberately ignoring the real exit.
   *   'exit'      match the real exit — the DEFAULT, stored as absence, so
   *               'exit'/'auto'/null all clear the entry.
   *   <zone>      a pin ('Europe/Oslo'). Outranks every lookup, and works
   *               whether or not Bulkhead manages the context.
   * Validated here rather than trusting the UI: a bad string must never
   * reach storage.
   * @param {string} id
   * @param {string | null} value
   * @returns {Promise<{ ok: boolean, error?: string, zone?: string | null }>}
   */
  async function setOverride (id, value) {
    if (typeof id !== 'string' || !id) return { ok: false, error: 'bad context' }
    let store = null
    if (value === 'off' || value === 'bulkhead') {
      store = value
    } else if (typeof value === 'string' && value && value !== 'auto' && value !== 'exit') {
      const z = zonelib.canonicalZone(value, Intl)
      if (!z) return { ok: false, error: `Not a timezone this engine knows: ${value}` }
      store = z
    }
    const next = { ...overrides }
    if (store === null) delete next[id]
    else next[id] = store
    await browser.storage.local.set({ tzOverrides: next })
    // loadSettings runs on the storage.onChanged echo; do it here too so the
    // sync below cannot race the event and read the previous value.
    await loadSettings()
    // `zone` answers "what is pinned", so mode keywords report null.
    return { ok: true, zone: store === 'off' || store === 'bulkhead' ? null : store }
  }

  /**
   * [bhtz] The per-context "a downstream proxy (FoxyProxy, residential) is
   * ON" switch. Only changes how EXIT mode learns the exit: ON => the
   * background measures the container's actual page path (which rides the
   * downstream proxy); OFF => the killswitch probe's exit is used. Stored
   * separately from the mode, so it survives mode changes.
   * @param {string} id
   * @param {boolean} on
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async function setFoxy (id, on) {
    if (typeof id !== 'string' || !id) return { ok: false, error: 'bad context' }
    const next = { ...foxy }
    if (on === true) next[id] = true
    else delete next[id]
    await browser.storage.local.set({ tzFoxy: next })
    await loadSettings()
    return { ok: true }
  }

  /** Synchronous read for the background's lookup triggers. @param {string} id @returns {boolean} */
  function foxyOn (id) {
    return foxy[id] === true
  }

  /* ----------------------------------------------------------------- reload */

  /**
   * Reload the context's http(s) tabs so already-open documents pick up a
   * changed zone. Only ever called from an explicit user action (popup) or
   * when reloadOnChange is on; a zone changing mid-session otherwise waits
   * for the next navigation, which is how every other page state works.
   * @param {string} id
   * @returns {Promise<number>} tabs reloaded
   */
  async function reloadContextTabs (id) {
    try {
      const tabs = await browser.tabs.query({ cookieStoreId: id })
      let n = 0
      for (const t of tabs) {
        if (t.id === undefined) continue
        if (!/^https?:/i.test(t.url || '')) continue
        browser.tabs.reload(t.id).catch(() => null)
        n++
      }
      if (n) log(`[bulkhead-tz] reloaded ${n} tab(s) in ${id} for a zone change`)
      return n
    } catch {
      return 0
    }
  }

  /* -------------------------------------------------------------- introspect */

  /** Synchronous read for the badge title. @param {string} id @returns {string} */
  function zoneOf (id) {
    const d = derived.get(id)
    return d && d.zone ? d.zone : ''
  }

  function snapshot () {
    return {
      enabled,
      reloadOnChange,
      /** false means world:'MAIN' registration was refused by this engine */
      supported: mainWorldOk,
      error: lastError,
      overrides: { ...overrides },
      foxy: { ...foxy },
      zones: Object.fromEntries([...derived].map(([id, d]) => [id, { ...d }]))
    }
  }

  /* ----------------------------------------------------------------- verify */

  /**
   * Source for browser.tabs.executeScript (ISOLATED world) behind the popup's
   * Verify button. The measurements themselves run IN THE PAGE REALM, reached
   * through window.wrappedJSObject.eval, and reproduce CreepJS's own
   * derivations — so the verdict is about what a fingerprinter measures, not
   * about what we intended to install.
   *
   * WHY NOT READ THROUGH XRAY FROM HERE (the old approach, and its two false
   * alarms):
   *   - Xray wrappers expose the ORIGINAL native DOM methods, bypassing the
   *     page's overrides. An iframe created from the isolated world therefore
   *     never triggers the engine's insertion-time realm capture, so the probe
   *     frame read as unpatched — the old "about:blank probe realm: error".
   *   - Xray's view of Date/Intl can diverge from the page's own patched
   *     values, so comparing a getter read through Xray against an Intl value
   *     read through Xray reported a disagreement the page itself never had —
   *     the old false "local getters vs Intl: DISAGREE" on a realm CreepJS
   *     passed clean.
   * Running the probe in the page realm measures exactly what the page (and
   * CreepJS) sees, with every patch active. The result is returned as a JSON
   * string, which crosses back through Xray as a plain primitive.
   *
   * The hour check reads formatToParts and normalises 24 -> 0: some ICU builds
   * render midnight as "24" even under hourCycle:'h23', which would otherwise
   * disagree with getHours()'s 0 at exactly that hour.
   *
   * If the page's CSP forbids eval (no 'unsafe-eval'), the in-page probe cannot
   * run; that is reported honestly rather than as a false inconsistency. The
   * timezone patch itself is unaffected — it is a MAIN-world content script,
   * which is CSP-exempt.
   * @returns {string}
   */
  function verifySource () {
    // Self-contained page-realm probe. No reference to anything outside the
    // page global; returns a JSON string of every observable CreepJS derives.
    const probe = `(function () {
  'use strict';
  var R = { ok: true };
  try {
    R.url = location.href;
    var now = new Date();
    R.tz = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    R.dateToString = String(now);
    R.offset = now.getTimezoneOffset();
    // CreepJS getTimezoneOffset(): local-string parse minus UTC parse.
    try {
      var p = JSON.stringify(now).slice(1, 11).split('-');
      R.offsetComputed = ~~((+new Date(p[1] + '/' + p[2] + '/' + p[0]) - +new Date(p[0] + '-' + p[1] + '-' + p[2])) / 60000);
    } catch (e) { R.offsetComputed = null; }
    // CreepJS decryptLocation(): year-1113 LMT, system vs resolvedOptions.
    try {
      var f = new Intl.DateTimeFormat('en', {
        timeZone: R.tz, year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric'
      });
      var anchor = +new Date('1113-07-01');
      R.lmtSystem = (+new Date('7/1/1113') - anchor) / 60000;
      R.lmtResolved = (+new Date(f.format(new Date('7/1/1113'))) - anchor) / 60000;
      R.lmtMatch = R.lmtSystem === R.lmtResolved;
    } catch (e) { R.lmtMatch = null; }
    // Internal consistency: local getters vs Intl for one instant. Read the
    // hour from formatToParts and normalise 24 -> 0 (ICU midnight quirk).
    try {
      var hp = new Intl.DateTimeFormat('en-US', { hour: '2-digit', hourCycle: 'h23' }).formatToParts(now);
      var h = NaN;
      for (var i = 0; i < hp.length; i++) { if (hp[i].type === 'hour') { h = (+hp[i].value) % 24; break; } }
      R.gettersAgree = now.getHours() === h;
    } catch (e) { R.gettersAgree = null; }
    // Probe realm: a fresh about:blank iframe created IN THE PAGE REALM, so the
    // engine's insertion-time capture patches it exactly as CreepJS's own
    // probe frame is patched.
    try {
      var fr = document.createElement('iframe');
      fr.style.display = 'none';
      (document.body || document.documentElement).appendChild(fr);
      var cw = fr.contentWindow;
      R.iframeTz = new cw.Intl.DateTimeFormat().resolvedOptions().timeZone;
      R.iframeOffset = new cw.Date().getTimezoneOffset();
      fr.remove();
    } catch (e) { R.iframeTz = null; }
    // The engine's own stamp.
    try { var st = window.__bhtz; R.stamp = st ? { zone: st.zone, late: st.late } : null; } catch (e) { R.stamp = null; }
  } catch (e) {
    R.ok = false;
    R.error = String((e && e.message) || e);
  }
  return JSON.stringify(R);
})()`
    return `(function () {
  'use strict';
  try {
    var w = window.wrappedJSObject;
    if (!w) return { ok: false, error: 'no page realm from here' };
    if (typeof w.eval !== 'function') return { ok: false, error: 'page realm eval unavailable' };
    return JSON.parse(w.eval(${JSON.stringify(probe)}));
  } catch (e) {
    return { ok: false, error: 'in-page verifier blocked (likely page CSP without unsafe-eval): ' + String((e && e.message) || e) };
  }
})();`
  }

  /* ------------------------------------------------------------------- boot */

  const api = {
    loadSettings,
    sync,
    drop,
    rehydrate,
    setOverride,
    setFoxy,
    foxyOn,
    setPageGeoSource,
    reloadContextTabs,
    zoneOf,
    snapshot,
    verifySource,
    payload
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  } else {
    root.tzlib = api
  }
})(globalThis)
