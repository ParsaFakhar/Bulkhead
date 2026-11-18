'use strict'
// The timezone MODE layer of tz.js: the four per-context sources
// (exit / bulkhead / pin / off), the downstream-proxy switch (tzFoxy), and
// the page-path evidence gate. zones.test.js proves the pure precedence;
// this file proves the wiring — storage round-trips, mode keywords through
// setOverride, foxy-gated page geo through sync, and what actually gets
// registered (zone baked into the payload, cookieStoreId filter, MAIN world).
const { test } = require('node:test')
const assert = require('node:assert')

// ---- the browser the delivery layer talks to ------------------------------
const store = {}
/** @type {{ opts: any, unregistered: boolean }[]} */
const registrations = []

global.zonelib = require('../../src/zones.js')
global.installTZRealm = function installTZRealm () {}
global.log = () => {}
global.browser = {
  storage: {
    local: {
      async get (keys) {
        const out = {}
        for (const k of keys) if (k in store) out[k] = store[k]
        return out
      },
      async set (obj) {
        Object.assign(store, obj)
      }
    }
  },
  contentScripts: {
    async register (opts) {
      const rec = { opts, unregistered: false }
      registrations.push(rec)
      return {
        async unregister () {
          rec.unregistered = true
        }
      }
    }
  },
  tabs: {
    async query () { return [] },
    async reload () {}
  }
}

const tzlib = require('../../src/tz.js')

const CFG_GB = {
  ip: '10.124.0.1', port: 1080, host: 'gb-lon-wg-001', socksHost: 'gb-lon-wg-001',
  city: 'London', country: 'United Kingdom', cc: 'gb',
  health: 'up',
  lastGeo: { country: 'United Kingdom', city: 'London', at: Date.now() },
  lastGeoVerified: true
}
const GEO_CH = { country: 'Switzerland', city: 'Zurich' }

/** The registrations still live for a context, newest last. */
function liveFor (id) {
  return registrations.filter(r => !r.unregistered && r.opts.cookieStoreId.includes(id))
}

test('setOverride accepts the mode keywords and stores them verbatim', async () => {
  const id = 'firefox-container-101'
  assert.equal((await tzlib.setOverride(id, 'bulkhead')).ok, true)
  assert.equal(store.tzOverrides[id], 'bulkhead')
  assert.equal(tzlib.snapshot().overrides[id], 'bulkhead')
  // 'exit' is the default and is stored as absence
  assert.equal((await tzlib.setOverride(id, 'exit')).ok, true)
  assert.equal(id in store.tzOverrides, false)
  // 'off' stores
  assert.equal((await tzlib.setOverride(id, 'off')).ok, true)
  assert.equal(store.tzOverrides[id], 'off')
  // 'auto' and null clear, like before
  assert.equal((await tzlib.setOverride(id, 'auto')).ok, true)
  assert.equal(id in store.tzOverrides, false)
})

test('setOverride still validates pins and rejects bad zones without storing', async () => {
  const id = 'firefox-container-102'
  const bad = await tzlib.setOverride(id, 'Mars/Olympus')
  assert.equal(bad.ok, false)
  assert.match(bad.error, /Not a timezone/)
  assert.equal(store.tzOverrides && id in store.tzOverrides, false)
  const good = await tzlib.setOverride(id, 'europe/oslo')
  assert.equal(good.ok, true)
  assert.equal(good.zone, 'Europe/Oslo')
  assert.equal(store.tzOverrides[id], 'Europe/Oslo')
})

test('bulkhead mode registers the assignment’s zone, ignoring the real exit', async () => {
  const id = 'firefox-container-103'
  await tzlib.setOverride(id, 'bulkhead')
  tzlib.setPageGeoSource(() => GEO_CH)
  await tzlib.setFoxy(id, true)
  // probe says UK, page path says CH, assignment says UK: bulkhead mode
  // deliberately answers with the assignment
  const r = await tzlib.sync(id, CFG_GB)
  assert.equal(r.zone, 'Europe/London')
  assert.equal(r.source, 'bulkhead')
  const live = liveFor(id)
  assert.equal(live.length, 1)
  assert.ok(live[0].opts.js[0].code.includes('Europe/London'))
  assert.equal(live[0].opts.world, 'MAIN')
  assert.equal(live[0].opts.runAt, 'document_start')
  await tzlib.setFoxy(id, false)
})

test('bulkhead mode on an unmanaged context has nothing to match', async () => {
  const id = 'firefox-container-104'
  await tzlib.setOverride(id, 'bulkhead')
  const r = await tzlib.sync(id, undefined)
  assert.equal(r.zone, null)
  assert.equal(r.source, 'unmanaged')
  assert.equal(liveFor(id).length, 0)
})

test('exit mode with downstream ON registers the page-path exit, even unmanaged', async () => {
  const id = 'firefox-container-105'
  tzlib.setPageGeoSource(cid => (cid === id ? GEO_CH : null))
  await tzlib.setFoxy(id, true)
  assert.equal(tzlib.foxyOn(id), true)
  assert.equal(tzlib.snapshot().foxy[id], true)
  // no assignment at all: FoxyProxy alone owns the routing
  const r = await tzlib.sync(id, undefined)
  assert.equal(r.zone, 'Europe/Zurich')
  assert.equal(r.source, 'page')
  assert.ok(liveFor(id)[0].opts.js[0].code.includes('Europe/Zurich'))
})

test('exit mode with downstream ON: page path beats the trusted probe', async () => {
  const id = 'firefox-container-106'
  tzlib.setPageGeoSource(cid => (cid === id ? GEO_CH : null))
  await tzlib.setFoxy(id, true)
  const r = await tzlib.sync(id, CFG_GB)
  assert.equal(r.zone, 'Europe/Zurich')
  assert.equal(r.source, 'page')
})

test('downstream OFF ignores page-path evidence entirely', async () => {
  const id = 'firefox-container-107'
  tzlib.setPageGeoSource(() => GEO_CH)
  await tzlib.setFoxy(id, false)
  assert.equal(tzlib.foxyOn(id), false)
  const r = await tzlib.sync(id, CFG_GB)
  assert.equal(r.zone, 'Europe/London')
  assert.equal(r.source, 'probe')
  // and unmanaged + OFF stays honest
  const u = await tzlib.sync('firefox-container-108', undefined)
  assert.equal(u.zone, null)
  assert.equal(u.source, 'unmanaged')
})

test('downstream ON with no page answer falls back to the probe', async () => {
  const id = 'firefox-container-109'
  tzlib.setPageGeoSource(() => null)
  await tzlib.setFoxy(id, true)
  const r = await tzlib.sync(id, CFG_GB)
  assert.equal(r.zone, 'Europe/London')
  assert.equal(r.source, 'probe')
})

test('a route-verified non-Mullvad exit still gets its zone while health blocks', async () => {
  const id = 'firefox-container-110'
  // the killswitch says down (not a Mullvad exit) but the route was proven
  // and the exit answered from Switzerland: exit mode matches it
  const c = {
    ...CFG_GB,
    health: 'down',
    lastGeo: { country: 'Switzerland', city: 'Zurich', at: Date.now() },
    lastGeoVerified: true
  }
  const r = await tzlib.sync(id, c)
  assert.equal(r.zone, 'Europe/Zurich')
  assert.equal(r.source, 'probe')
  // an UNverified route is not evidence: falls back to the assignment
  const u = await tzlib.sync('firefox-container-111', { ...c, lastGeoVerified: false })
  assert.equal(u.zone, 'Europe/London')
  assert.equal(u.source, 'relay')
})

test('a pin works on an unmanaged context and outranks page-path evidence', async () => {
  const id = 'firefox-container-112'
  tzlib.setPageGeoSource(() => GEO_CH)
  await tzlib.setFoxy(id, true)
  await tzlib.setOverride(id, 'Asia/Tokyo')
  const r = await tzlib.sync(id, undefined)
  assert.equal(r.zone, 'Asia/Tokyo')
  assert.equal(r.source, 'pin')
})

test('off unregisters even with downstream evidence present', async () => {
  const id = 'firefox-container-113'
  tzlib.setPageGeoSource(() => GEO_CH)
  await tzlib.setFoxy(id, true)
  await tzlib.sync(id, undefined)
  assert.equal(liveFor(id).length, 1)
  await tzlib.setOverride(id, 'off')
  const r = await tzlib.sync(id, undefined)
  assert.equal(r.zone, null)
  assert.equal(r.source, 'off')
  assert.equal(liveFor(id).length, 0)
})

test('setFoxy persists and survives a settings reload', async () => {
  const id = 'firefox-container-114'
  await tzlib.setFoxy(id, true)
  assert.equal(store.tzFoxy[id], true)
  // a fresh read from storage (what the onChanged echo does) keeps it
  await tzlib.loadSettings()
  assert.equal(tzlib.foxyOn(id), true)
  await tzlib.setFoxy(id, false)
  assert.equal(id in store.tzFoxy, false)
  await tzlib.loadSettings()
  assert.equal(tzlib.foxyOn(id), false)
})
