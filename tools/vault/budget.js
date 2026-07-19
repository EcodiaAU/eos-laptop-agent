'use strict'
// tools/vault/budget.js - OPEN-tier resolve budgets + fail-closed freeze + single
// -flight lock. The red-team's T1-volume defence: OPEN tier is NOT unbudgeted. A
// resolve burst, or drawing more than one backup code per genuine login, or too
// many consecutive failures, AUTO-FREEZES the service fail-closed (alarming a
// travelling Tate is not a control). A frozen service needs a manual clear.
// Pure + in-memory with an injected clock so it is deterministic under test; the
// daemon persists counters to vault_budget between restarts.
// Design: backend/docs/security/2fa-credential-vault-architecture-2026-07-17.md s5.

const DEFAULTS = Object.freeze({
  windowSeconds: 3600,        // rolling window
  perServiceMax: 10,          // resolves per service per window before freeze
  globalMax: 40,              // resolves across ALL services per window before global freeze
  maxConsecutiveFails: 3,     // consecutive fill/verify failures before circuit-breaker freeze
})

function createBudget(opts) {
  opts = opts || {}
  const cfg = Object.assign({}, DEFAULTS, opts.config)
  const now = opts.now || (() => Math.floor(Date.now() / 1000))
  const onFreeze = opts.onFreeze || (() => {})   // hook to alarm Tate

  const state = new Map()      // service -> { windowStart, count, fails, frozen, reason }
  const inflight = new Set()   // single-flight lock per service
  let globalWindowStart = now()
  let globalCount = 0

  function svc(service) {
    if (!state.has(service)) state.set(service, { windowStart: now(), count: 0, fails: 0, frozen: false, reason: null })
    return state.get(service)
  }
  function rollWindow(s) {
    if (now() - s.windowStart >= cfg.windowSeconds) { s.windowStart = now(); s.count = 0 }
  }
  function rollGlobal() {
    if (now() - globalWindowStart >= cfg.windowSeconds) { globalWindowStart = now(); globalCount = 0 }
  }
  function freeze(service, reason) {
    const s = svc(service); s.frozen = true; s.reason = reason
    try { onFreeze(service, reason) } catch (_e) {}
  }

  // allow(service) -> {ok:true} | {ok:false, reason}. Called BEFORE any secret is
  // touched. Enforces frozen state, single-flight, per-service + global caps.
  function allow(service) {
    const s = svc(service)
    if (s.frozen) return { ok: false, reason: 'frozen:' + (s.reason || 'unknown') }
    rollWindow(s); rollGlobal()
    if (inflight.has(service)) return { ok: false, reason: 'in-flight' }
    if (s.count >= cfg.perServiceMax) { freeze(service, 'per-service-budget-exceeded'); return { ok: false, reason: 'per-service-budget' } }
    if (globalCount >= cfg.globalMax) { freeze(service, 'global-budget-exceeded'); return { ok: false, reason: 'global-budget' } }
    inflight.add(service)   // held until recordResolve / release
    return { ok: true }
  }

  // recordResolve - a resolve completed (fill attempted). Increments counters and
  // releases the single-flight lock.
  function recordResolve(service) {
    const s = svc(service); rollWindow(s); rollGlobal()
    s.count += 1; globalCount += 1
    inflight.delete(service)
  }

  // recordFailure - a fill/verify failed. Trips the circuit breaker at the
  // consecutive-fail threshold. Also releases the lock.
  function recordFailure(service) {
    const s = svc(service)
    s.fails += 1
    inflight.delete(service)
    if (s.fails >= cfg.maxConsecutiveFails) freeze(service, 'consecutive-failures')
  }

  // recordSuccess - reset the consecutive-fail counter after a confirmed success.
  function recordSuccess(service) { svc(service).fails = 0 }

  function release(service) { inflight.delete(service) }
  function isFrozen(service) { return !!svc(service).frozen }
  function clearFreeze(service) { const s = svc(service); s.frozen = false; s.reason = null; s.fails = 0; s.count = 0; s.windowStart = now() } // manual only: fresh window so it does not instantly re-freeze
  function snapshot() {
    const out = {}
    for (const [k, v] of state) out[k] = { count: v.count, fails: v.fails, frozen: v.frozen, reason: v.reason }
    return { services: out, globalCount }
  }

  return { allow, recordResolve, recordFailure, recordSuccess, release, freeze, isFrozen, clearFreeze, snapshot, config: cfg }
}

module.exports = { createBudget, DEFAULTS }
