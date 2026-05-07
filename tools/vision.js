// vision.js - vision-first locator + click primitives.
//
// vision.locate({ target, expected_count?, screenshot_base64? })
//   - Captures screenshot (or accepts one), proxies to backend
//     /api/laptop-vision/locate which holds the Anthropic vision creds.
//     Returns { matches, ambiguous, reasoning }.
//
// vision.click({ target, context_url?, cache_ttl_s?, verify_after?, timeout_ms?, viewport? })
//   - Fast-path: bundles screenshot + (cached or fresh) locate + input.click + optional verify
//     into ONE tool call. Returns { clicked, coords, latency_ms, cache_hit, verify_result }.
//   - Cache key = sha1(url_origin_path + viewport + target_descriptor) under
//     kv_store namespace `macros.vision_cache.<sha1>`. TTL default 300s.
//
// vision.cacheClear({ pattern? })
//   - Clears the cache. Pattern is optional substring; absent = clear all.
//
// vision.cacheStats()
//   - Aggregate stats: total/live/stale entries, hit count, top targets.
//
// The agent does NOT hold an Anthropic key. The backend proxy does.
// Doctrine: ~/ecodiaos/patterns/macros-learn-by-doing-vision-first-run-with-question-surface.md
//
// Shipped 29 Apr 2026 (vision.locate by fork_mojsk7dl_c4424f).
// vision.click + cache primitives added by fork_mojvibbw_f82adc 29 Apr 2026.

const crypto = require('crypto');
const screenshotMod = require('./screenshot');
const inputMod = require('./input');

const BACKEND_URL = process.env.ECODIAOS_BACKEND_URL || 'https://api.admin.ecodia.au';

// ─── helpers ─────────────────────────────────────────────────────────

function _sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

function _normaliseUrl(u) {
  if (!u || typeof u !== 'string') return '';
  try {
    const parsed = new URL(u);
    return (parsed.origin + parsed.pathname).replace(/\/$/, '');
  } catch {
    return u.split('?')[0].split('#')[0];
  }
}

function _cacheKey({ context_url, viewport, target }) {
  const v = viewport ? `${viewport.w}x${viewport.h}` : 'unknown';
  return _sha1(`${_normaliseUrl(context_url)}::${v}::${target}`);
}

async function _captureScreenshot() {
  const shot = await screenshotMod.screenshot({});
  const b64 = shot && (shot.image || shot.base64 || shot.data);
  if (!b64) {
    throw new Error('vision: screenshot capture returned no image data');
  }
  return { b64, width: shot.width, height: shot.height };
}

async function _backendFetch(path, opts) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeout_ms || 30_000);
  try {
    const resp = await fetch(`${BACKEND_URL}${path}`, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    const text = await resp.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { _raw: text }; }
    return { ok: resp.ok, status: resp.status, body: parsed };
  } finally {
    clearTimeout(t);
  }
}

// ─── vision.locate (existing, untouched) ────────────────────────────

async function locate(params) {
  const { target, expected_count, screenshot_base64 } = params || {};
  if (!target || typeof target !== 'string') {
    throw new Error('vision.locate: target (string) required');
  }

  let imgB64 = screenshot_base64;
  if (!imgB64) {
    const shot = await _captureScreenshot();
    imgB64 = shot.b64;
  }

  const body = { screenshot_base64: imgB64, target };
  if (expected_count != null) body.expected_count = expected_count;

  const r = await _backendFetch('/api/laptop-vision/locate', { method: 'POST', body, timeout_ms: 45_000 });
  if (!r.ok) {
    throw new Error(`vision.locate: backend ${r.status}: ${JSON.stringify(r.body).slice(0, 500)}`);
  }
  return r.body;
}

// ─── vision.click — bundled fast-path ───────────────────────────────

async function click(params) {
  const startedAt = Date.now();
  const {
    target,
    context_url,
    cache_ttl_s = 300,
    verify_after,
    timeout_ms = 5000,
    viewport: vpHint,
  } = params || {};

  if (!target || typeof target !== 'string') {
    throw new Error('vision.click: target (string) required');
  }

  const breakdown = {};
  let cacheHit = false;
  let coords = null;
  let cacheKey = null;
  let viewport = vpHint || null;

  // 1. Cache lookup if context_url provided
  if (context_url) {
    const cacheLookupStart = Date.now();
    // For the cache key we need a viewport; if not provided, use a placeholder
    // and rely on the post-screenshot real viewport. The cache key with the
    // hinted viewport is good enough for repeats from the same caller flow.
    const lookupViewport = viewport || { w: 0, h: 0 };
    cacheKey = _cacheKey({ context_url, viewport: lookupViewport, target });
    try {
      const r = await _backendFetch(`/api/laptop-vision/cache/${cacheKey}`, { method: 'GET', timeout_ms: 5000 });
      breakdown.cache_check_ms = Date.now() - cacheLookupStart;
      if (r.ok && r.body && r.body.hit) {
        cacheHit = true;
        coords = r.body.entry.coords;
        viewport = r.body.entry.viewport || viewport;
      }
    } catch (err) {
      breakdown.cache_check_ms = Date.now() - cacheLookupStart;
      breakdown.cache_check_error = err.message;
    }
  }

  // 2. On miss, screenshot + vision.locate
  if (!coords) {
    const shotStart = Date.now();
    let imgB64;
    try {
      const shot = await _captureScreenshot();
      imgB64 = shot.b64;
      if (shot.width && shot.height) {
        viewport = viewport || { w: shot.width, h: shot.height };
      }
    } catch (err) {
      return {
        clicked: false,
        reason: 'screenshot_failed',
        error: err.message,
        latency_ms: Date.now() - startedAt,
        cache_hit: false,
      };
    }
    breakdown.screenshot_ms = Date.now() - shotStart;

    const visionStart = Date.now();
    let located;
    try {
      const r = await _backendFetch('/api/laptop-vision/locate', {
        method: 'POST',
        body: { screenshot_base64: imgB64, target },
        timeout_ms: timeout_ms,
      });
      breakdown.vision_ms = Date.now() - visionStart;
      if (!r.ok) {
        return {
          clicked: false,
          reason: 'vision_proxy_error',
          status: r.status,
          detail: r.body,
          latency_ms: Date.now() - startedAt,
          cache_hit: false,
          breakdown,
        };
      }
      located = r.body;
    } catch (err) {
      return {
        clicked: false,
        reason: 'vision_request_failed',
        error: err.message,
        latency_ms: Date.now() - startedAt,
        cache_hit: false,
        breakdown,
      };
    }

    if (!located.matches || located.matches.length === 0) {
      return {
        clicked: false,
        reason: 'no_match',
        reasoning: located.reasoning,
        latency_ms: Date.now() - startedAt,
        cache_hit: false,
        breakdown,
      };
    }
    if (located.ambiguous && located.matches.length > 1) {
      return {
        clicked: false,
        reason: 'ambiguous',
        candidates: located.matches.map(m => ({ x: m.x, y: m.y, label: m.label, confidence: m.confidence })),
        reasoning: located.reasoning,
        latency_ms: Date.now() - startedAt,
        cache_hit: false,
        breakdown,
      };
    }

    const m = located.matches[0];
    coords = { x: m.x, y: m.y };

    // 3. Cache store (only on successful confident locate, only if context_url given)
    if (context_url && cacheKey) {
      const storeStart = Date.now();
      const newKey = _cacheKey({ context_url, viewport: viewport || { w: 0, h: 0 }, target });
      try {
        const entry = {
          url_pattern: _normaliseUrl(context_url),
          viewport,
          target_descriptor: target,
          coords,
          confidence: m.confidence,
          label: m.label,
          observed_at: new Date().toISOString(),
          ttl_s: cache_ttl_s,
          hit_count: 0,
          last_used_at: new Date().toISOString(),
        };
        await _backendFetch(`/api/laptop-vision/cache/${newKey}`, {
          method: 'PUT',
          body: { entry },
          timeout_ms: 5000,
        });
        cacheKey = newKey;
        breakdown.cache_store_ms = Date.now() - storeStart;
      } catch (err) {
        breakdown.cache_store_ms = Date.now() - storeStart;
        breakdown.cache_store_error = err.message;
      }
    }
  }

  // 4. Fire input.click at coords
  const clickStart = Date.now();
  try {
    await inputMod.click({ x: coords.x, y: coords.y });
  } catch (err) {
    return {
      clicked: false,
      reason: 'click_failed',
      coords,
      error: err.message,
      latency_ms: Date.now() - startedAt,
      cache_hit: cacheHit,
      breakdown,
    };
  }
  breakdown.click_ms = Date.now() - clickStart;

  // 5. If cache_hit, bump hit_count async (fire-and-forget on backend)
  if (cacheHit && cacheKey) {
    _backendFetch(`/api/laptop-vision/cache/${cacheKey}`, { method: 'GET', timeout_ms: 2000 })
      .then(r => {
        if (r.ok && r.body && r.body.entry) {
          const e = r.body.entry;
          e.hit_count = (e.hit_count || 0) + 1;
          e.last_used_at = new Date().toISOString();
          return _backendFetch(`/api/laptop-vision/cache/${cacheKey}`, {
            method: 'PUT',
            body: { entry: e },
            timeout_ms: 2000,
          });
        }
      })
      .catch(() => {}); // fire-and-forget
  }

  // 6. Optional verify
  let verify_result = null;
  if (verify_after) {
    const verifyStart = Date.now();
    try {
      // Small settle pause so the click can take effect before screenshot
      await new Promise(r => setTimeout(r, 200));
      const shot = await _captureScreenshot();
      const r = await _backendFetch('/api/laptop-vision/locate', {
        method: 'POST',
        body: { screenshot_base64: shot.b64, target: verify_after },
        timeout_ms: timeout_ms,
      });
      breakdown.verify_ms = Date.now() - verifyStart;
      if (r.ok && r.body && r.body.matches && r.body.matches.length > 0 && !r.body.ambiguous) {
        verify_result = { found: true, label: r.body.matches[0].label, confidence: r.body.matches[0].confidence };
      } else {
        verify_result = { found: false, reasoning: r.body && r.body.reasoning };
      }
    } catch (err) {
      breakdown.verify_ms = Date.now() - verifyStart;
      verify_result = { found: false, error: err.message };
    }
  }

  return {
    clicked: true,
    coords,
    cache_hit: cacheHit,
    cache_key: cacheKey,
    latency_ms: Date.now() - startedAt,
    breakdown,
    verify_result,
  };
}

// ─── vision.cacheClear ───────────────────────────────────────────────

async function cacheClear(params) {
  const { pattern } = params || {};
  const r = await _backendFetch('/api/laptop-vision/cache', {
    method: 'DELETE',
    body: pattern ? { pattern } : {},
    timeout_ms: 10_000,
  });
  if (!r.ok) {
    throw new Error(`vision.cacheClear: backend ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  }
  return r.body;
}

// ─── vision.cacheStats ───────────────────────────────────────────────

async function cacheStats() {
  const r = await _backendFetch('/api/laptop-vision/cache-stats', { method: 'GET', timeout_ms: 10_000 });
  if (!r.ok) {
    throw new Error(`vision.cacheStats: backend ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  }
  return r.body;
}

module.exports = { locate, click, cacheClear, cacheStats };
