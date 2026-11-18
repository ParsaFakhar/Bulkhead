'use strict'
// Regression guard for rehydrate() (tz.js): contexts whose only claim to a
// zone is the downstream-proxy switch (foxy ON, no assignment, no override)
// must survive the startup prune AND be rebuilt from storage on a cold
// start. Registrations do not survive a browser restart, so rehydrate is
// the ONLY thing that puts a foxy-only context's zone back — before the
// fix it pruned them and never synced them, leaving pages on the system
// zone while the UI claimed a matched one. Pin-only unmanaged contexts ride
// the same path. node:test gives this file its own process, so tz.js starts
// with an empty registration map — exactly the post-restart state.
const { test } = require('node:test')
const assert = require('node:assert')

// ---- the browser the delivery layer talks to (same shape as tz-modes) ----
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

const GEO_CH = { country: 'Switzerland', city: 'Zurich' }
const CFG_GB = {
  ip: '10.124.0.1', port: 1080, host: 'gb-lon-wg-001', socksHost: 'gb-lon-wg-001',
  city: 'London', country: 'United Kingdom', cc: 'gb',
  health: 'up',
  lastGeo: { country: 'United Kingdom', city: 'London', at: Date.now() },
  lastGeoVerified: true
}

/** The registrations still live for a context, newest last. */
function liveFor (id) {
  return registrations.filter(r => !r.unregistered && r.opts.cookieStoreId.includes(id))
}

test('rehydrate rebuilds foxy-only and pin-only contexts from storage on a cold start', async () => {
  const foxyId = 'firefox-container-201'
  const pinId = 'firefox-container-202'
  // Storage as it stands after a restart: a downstream-proxy context with
  // no assignment and no override, and a pinned unmanaged context.
  await tzlib.setFoxy(foxyId, true)
  await tzlib.setOverride(pinId, 'Asia/Tokyo')
  tzlib.setPageGeoSource(cid => (cid === foxyId ? GEO_CH : null))
  // Neither setter registers anything; registrations died with the restart.
  assert.equal(liveFor(foxyId).length, 0)
  assert.equal(liveFor(pinId).length, 0)

  await tzlib.rehydrate({})

  assert.equal(liveFor(foxyId).length, 1)
  assert.ok(liveFor(foxyId)[0].opts.js[0].code.includes('Europe/Zurich'))
  assert.equal(liveFor(pinId).length, 1)
  assert.ok(liveFor(pinId)[0].opts.js[0].code.includes('Asia/Tokyo'))
})

test('rehydrate prunes gone contexts but keeps foxy-only registrations', async () => {
  const foxyId = 'firefox-container-203'
  const goneId = 'firefox-container-204'
  tzlib.setPageGeoSource(cid => (cid === foxyId ? GEO_CH : null))
  await tzlib.setFoxy(foxyId, true)
  await tzlib.sync(foxyId, undefined)
  // registered under an assignment that is about to disappear
  await tzlib.sync(goneId, CFG_GB)
  assert.equal(liveFor(foxyId).length, 1)
  assert.equal(liveFor(goneId).length, 1)

  // the assignment is gone: no container, no override, no foxy for goneId
  await tzlib.rehydrate({})

  assert.equal(liveFor(goneId).length, 0)
  assert.equal(liveFor(foxyId).length, 1)
  assert.ok(liveFor(foxyId)[0].opts.js[0].code.includes('Europe/Zurich'))
})

test('rehydrate still syncs assigned contexts', async () => {
  const id = 'firefox-container-205'
  await tzlib.rehydrate({ [id]: CFG_GB })
  assert.equal(liveFor(id).length, 1)
  assert.ok(liveFor(id)[0].opts.js[0].code.includes('Europe/London'))
})

test('with matching disabled, rehydrate keeps pins and pulls matched scripts', async () => {
  // The global switch stops automatic matching; a pin is a standing
  // instruction and stands. The settings echo used to call a hard
  // unregisterAll() here, which pulled the pin too — until the next probe
  // verdict re-registered it. rehydrate + derive is the one choke point.
  const pinId = 'firefox-container-206'
  const matchedId = 'firefox-container-207'
  await tzlib.setOverride(pinId, 'Europe/Oslo')
  await tzlib.sync(matchedId, CFG_GB)
  assert.equal(liveFor(matchedId).length, 1)

  store.tzEnabled = false
  await tzlib.loadSettings()
  await tzlib.rehydrate({ [matchedId]: CFG_GB })

  assert.equal(liveFor(matchedId).length, 0)
  assert.equal(liveFor(pinId).length, 1)
  assert.ok(liveFor(pinId)[0].opts.js[0].code.includes('Europe/Oslo'))

  store.tzEnabled = true
  await tzlib.loadSettings()
})
