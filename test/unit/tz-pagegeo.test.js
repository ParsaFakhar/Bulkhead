'use strict'
// Regression guard for ensurePageGeo() (background.js): a FRESH page-path
// cache hit must re-assert the registration (tzlib.sync) before returning.
// The cache outlives registrations — a rehydrate or a storage echo can
// rebuild them between lookups — so returning the cached answer without
// syncing left foxy-only contexts unregistered while the geo said matched.
//
// background.js is a top-level background script, not a module; like
// tz-verify.test.js does with verifySource, this file extracts the REAL
// function source and runs it in a node:vm context with only the
// dependencies it touches mocked. No copy of the logic lives here.
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const src = fs.readFileSync(path.join(__dirname, '../../src/background.js'), 'utf8')
const start = src.indexOf('async function ensurePageGeo')
assert.ok(start > 0, 'ensurePageGeo not found in background.js')
const end = src.indexOf('\n}\n', start) // first column-0 close: the function's own
assert.ok(end > start, 'ensurePageGeo body not terminated')
const fnSrc = src.slice(start, end + 3)
const ttl = src.match(/const PAGE_GEO_TTL_MS = ([^\n]+)/)
assert.ok(ttl, 'PAGE_GEO_TTL_MS not found in background.js')

const ID = 'firefox-container-301'
const CFG = { host: 'gb-lon-wg-001', health: 'up' }
const GEO = { ip: '203.0.113.7', country: 'Switzerland', city: 'Zurich' }

/**
 * A vm context holding the real ensurePageGeo plus recording mocks for
 * everything it touches. `geo` is what the next lookup answers (null =
 * failure); `cache` seeds pageGeo with a record of the given age.
 */
function harness ({ containers = {}, geo = null, foxy = true, enabled = true, cache = null } = {}) {
  const calls = { sync: [], lookups: [], badges: [] }
  const pageGeo = new Map()
  if (cache) pageGeo.set(ID, { ...GEO, at: Date.now() - cache.ageMs })
  const sandbox = {
    pageGeo,
    pageGeoInFlight: new Map(),
    state: { containers },
    log: () => {},
    updateBadgesFor: id => calls.badges.push(id),
    lookupExitGeo: async (id) => {
      calls.lookups.push(id)
      return geo
    },
    tzlib: {
      snapshot: () => ({ enabled }),
      foxyOn: id => foxy === true && id === ID,
      sync: async (id, c) => {
        calls.sync.push([id, c])
        return { zone: null, source: 'page', changed: false }
      }
    }
  }
  vm.createContext(sandbox)
  vm.runInContext(`const PAGE_GEO_TTL_MS = ${ttl[1]};\n${fnSrc}\n;globalThis.__run = (id, force) => ensurePageGeo(id, force);`, sandbox)
  return { calls, pageGeo, run: (force = false) => sandbox.__run(ID, force) }
}

const TTL_MS = vm.runInNewContext(ttl[1])

test('a fresh cache hit re-syncs the registration before returning (the fix)', async () => {
  const h = harness({ containers: { [ID]: CFG }, cache: { ageMs: 1000 } })
  const rec = await h.run()
  assert.equal(rec.country, 'Switzerland')
  assert.equal(rec.city, 'Zurich')
  // the registration was re-asserted with the live assignment, no new lookup
  assert.equal(h.calls.sync.length, 1)
  assert.equal(h.calls.sync[0][0], ID)
  assert.strictEqual(h.calls.sync[0][1], CFG)
  assert.equal(h.calls.lookups.length, 0)
})

test('a fresh cache hit on an unmanaged foxy-only context syncs with undefined', async () => {
  const h = harness({ containers: {}, cache: { ageMs: 1000 } })
  const rec = await h.run()
  assert.equal(rec.city, 'Zurich')
  assert.equal(h.calls.sync.length, 1)
  assert.equal(h.calls.sync[0][0], ID)
  assert.strictEqual(h.calls.sync[0][1], undefined)
  assert.equal(h.calls.lookups.length, 0)
})

test('a stale cache hit refetches and syncs the fresh answer', async () => {
  const h = harness({ containers: { [ID]: CFG }, geo: GEO, cache: { ageMs: TTL_MS + 1000 } })
  const rec = await h.run()
  assert.equal(h.calls.lookups.length, 1)
  assert.equal(rec.ip, GEO.ip)
  assert.ok(Date.now() - rec.at < TTL_MS)
  assert.strictEqual(CFG.lastPageGeo, rec)
  assert.equal(h.calls.sync.length, 1)
  assert.strictEqual(h.calls.sync[0][1], CFG)
  assert.deepEqual(h.calls.badges, [ID])
})

test('force skips the TTL even on a fresh hit', async () => {
  const h = harness({ containers: { [ID]: CFG }, geo: GEO, cache: { ageMs: 1000 } })
  await h.run(true)
  assert.equal(h.calls.lookups.length, 1)
})

test('concurrent stale lookups dedup into one round-trip', async () => {
  const h = harness({ containers: { [ID]: CFG }, geo: GEO })
  const [a, b] = await Promise.all([h.run(), h.run()])
  assert.equal(h.calls.lookups.length, 1)
  assert.strictEqual(a, b)
})

test('a failed lookup drops a stale answer and re-syncs without it', async () => {
  const h = harness({ containers: { [ID]: CFG }, geo: null, cache: { ageMs: TTL_MS + 1000 } })
  await h.run()
  // the cache no longer claims an exit it cannot prove; derive falls back
  // to the probe's evidence on the next sync
  assert.equal(h.pageGeo.has(ID), false)
  assert.strictEqual(CFG.lastPageGeo, null)
  assert.equal(h.calls.sync.length, 1)
  assert.strictEqual(h.calls.sync[0][1], CFG)
})

test('the gate holds: downstream OFF or matching disabled does nothing', async () => {
  const off = harness({ containers: { [ID]: CFG }, cache: { ageMs: 1000 }, foxy: false })
  assert.equal(await off.run(), null)
  assert.equal(off.calls.sync.length, 0)
  assert.equal(off.calls.lookups.length, 0)
  const disabled = harness({ containers: { [ID]: CFG }, cache: { ageMs: 1000 }, enabled: false })
  assert.equal(await disabled.run(), null)
  assert.equal(disabled.calls.sync.length, 0)
})
