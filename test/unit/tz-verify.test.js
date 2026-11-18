'use strict'
// Regression guard for the popup's Verify probe (tz.js verifySource).
//
// The old probe read the page through Xray wrappers from the isolated world.
// That produced two false alarms on a realm CreepJS passed clean:
//   - "local getters vs Intl: DISAGREE" (Xray's Date/Intl view diverged from
//     the page's own patched values), and
//   - "about:blank probe realm: error" (Xray bypasses the page's overridden
//     DOM methods, so the probe iframe was never patched by the engine).
//
// The fix runs the probe IN THE PAGE REALM via wrappedJSObject.eval. This test
// builds the actual registered payload in a node:vm realm (V8, like the rest
// of the suite), bridges the isolated-world wrapper's eval into it, and checks
// every derivation agrees — including the probe iframe, which here shares the
// patched realm exactly as a same-origin about:blank frame does in the page.
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const realmSrc = fs.readFileSync(path.join(__dirname, '../../src/tz-realm.js'), 'utf8')
const tzlib = require('../../src/tz.js')

// A patched page realm with just enough DOM for the probe's iframe check.
function buildPatchedPage (zone) {
  const ctx = vm.createContext({ console: { log () {}, warn () {}, error () {}, debug () {} } })
  vm.runInContext(realmSrc, ctx)
  const fn = vm.runInContext('installTZRealm.toString()', ctx)
  const cfg = { timeZone: zone, stealth: 'deep', workerMode: 'off', serviceWorkerMode: 'warn', debug: false }
  vm.runInContext('(function (__tzl, __cfg) { __tzl(__cfg, __tzl); })(' + fn + ', ' + JSON.stringify(cfg) + ');', ctx)
  // The probe iframe's contentWindow shares this (patched) realm, which is what
  // a same-origin about:blank frame inherits in the page once the engine's
  // insertion-time capture has patched it.
  vm.runInContext(`
    window = globalThis;
    location = { href: 'https://example.test/' };
    document = {
      body: { appendChild: function () {} },
      documentElement: { appendChild: function () {} },
      createElement: function () { return { style: {}, contentWindow: globalThis, remove: function () {} }; }
    };
    Object.defineProperty(window, '__bhtz', { configurable: true, value: { zone: ${JSON.stringify(zone)}, late: false } });
  `, ctx)
  return ctx
}

// Run the real verifySource() wrapper with its page-realm eval bridged into
// the patched context, exactly as tabs.executeScript would in the browser.
function runVerify (zone) {
  const page = buildPatchedPage(zone)
  const iso = vm.createContext({ bridge: code => vm.runInContext(code, page) })
  vm.runInContext('window = { wrappedJSObject: { eval: bridge } };', iso)
  return vm.runInContext(tzlib.verifySource(), iso)
}

const ZONES = ['Asia/Tokyo', 'Europe/Oslo', 'Asia/Kolkata', 'Pacific/Chatham', 'America/New_York', 'UTC']

for (const zone of ZONES) {
  test(`Verify reports a fully consistent page realm for ${zone}`, () => {
    const r = runVerify(zone)
    const canon = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone
    assert.equal(r.ok, true)
    assert.equal(r.tz, canon, 'reported zone')
    assert.equal(r.offsetComputed, r.offset, 'CreepJS offsetComputed === offset')
    assert.equal(r.lmtMatch, true, 'year-1113 LMT system === resolvedOptions')
    assert.equal(r.gettersAgree, true, 'local getters vs Intl agree (no false DISAGREE)')
    assert.equal(r.iframeTz, r.tz, 'about:blank probe realm presents the same zone (no false error)')
    assert.equal(r.iframeOffset, r.offset, 'probe realm offset agrees')
    assert.equal(r.stamp && r.stamp.zone, zone, 'engine stamp present')
    assert.equal(r.stamp && r.stamp.late, false, 'injection not late')
  })
}

test('Verify measures in the page realm, not through Xray (regression guard)', () => {
  const src = tzlib.verifySource()
  // Must reach the page realm via eval...
  assert.match(src, /window\.wrappedJSObject/, 'probe must reach the page realm')
  assert.match(src, /w\.eval\(/, 'probe must run via page-realm eval')
  // ...and normalise the ICU midnight-"24" hour quirk.
  assert.match(src, /% 24/, 'hour comparison must normalise 24 -> 0')
  // Must NOT regress to reading Date/Intl through Xray from the isolated world.
  assert.equal(/new w\.Intl\.DateTimeFormat/.test(src), false, 'no Xray Intl reads')
  assert.equal(/var D = w\.Date/.test(src), false, 'no Xray Date reads')
})

test('Verify reports honestly when the page realm cannot be reached', () => {
  const iso = vm.createContext({})
  vm.runInContext('window = {};', iso) // no wrappedJSObject
  const r = vm.runInContext(tzlib.verifySource(), iso)
  assert.equal(r.ok, false)
  assert.match(r.error, /no page realm/)
})

test('Verify reports honestly when page CSP blocks eval', () => {
  const iso = vm.createContext({
    blockedEval: () => { throw new Error('call to eval() blocked by CSP') }
  })
  vm.runInContext('window = { wrappedJSObject: { eval: blockedEval } };', iso)
  const r = vm.runInContext(tzlib.verifySource(), iso)
  assert.equal(r.ok, false)
  assert.match(r.error, /CSP/)
})
