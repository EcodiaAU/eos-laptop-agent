// macroHandlers/vercel-login.js
// Open vercel.com/login, click GitHub OAuth, follow through to dashboard.
// Tate's Chrome already holds an authenticated GitHub session; the authorize
// step generally auto-completes.
//
// Wait discipline: polling waits via waitForPageReady, no static post-nav sleeps.
// Authored by fork_mojldsgx_7b55bf, 29 Apr 2026.

const { newTabAndNavigate, waitForPageReady } = require('./common')

const COORDS = {
  github_button: { x: 720, y: 520 },
  authorize_button: { x: 720, y: 600 },
}

async function handle({ params, helpers }) {
  params = params || {}
  const timeoutMs = params.timeout_ms || 60000
  const startTs = Date.now()
  const deadline = startTs + timeoutMs
  const ttl = () => Math.max(deadline - Date.now(), 1000)

  helpers.note(`vercel-login start timeout_ms=${timeoutMs}`)
  helpers.mark('start')

  await newTabAndNavigate(helpers, 'https://vercel.com/login', { changeMaxMs: Math.min(10000, ttl()), settleMaxMs: Math.min(8000, ttl()) })
  helpers.mark('after_nav')

  const preShot = await helpers.screenshot.screenshot({ format: 'png' })
  helpers.mark('after_pre_screenshot')

  await helpers.input.click({ x: COORDS.github_button.x, y: COORDS.github_button.y })
  await helpers.sleep(1200)
  // Continue with GitHub triggers an OAuth redirect chain. Long page-ready wait.
  await waitForPageReady(helpers, { changeMaxMs: Math.min(10000, ttl()), settleMaxMs: Math.min(8000, ttl()) })
  helpers.mark('after_github_click')

  // Authorize button may not appear if Vercel-on-GitHub was previously authorised.
  await helpers.input.click({ x: COORDS.authorize_button.x, y: COORDS.authorize_button.y })
  await helpers.sleep(1500)
  await waitForPageReady(helpers, { changeMaxMs: Math.min(10000, ttl()), settleMaxMs: Math.min(8000, ttl()) })
  helpers.mark('after_authorize')

  const postShot = await helpers.screenshot.screenshot({ format: 'png' })
  helpers.mark('after_post_screenshot')

  return {
    success: true,
    expected_final_url_contains: 'vercel.com',
    timeout_ms_used: timeoutMs,
    elapsed_ms: Date.now() - startTs,
    preScreenshot: preShot && preShot.image ? `${(preShot.image || '').length} bytes b64` : null,
    postScreenshot: postShot && postShot.image ? `${(postShot.image || '').length} bytes b64` : null,
    note: 'Verify dashboard via postScreenshot. If GitHub session was unauthenticated the macro will leave Chrome on github.com/login.',
  }
}

module.exports = {
  name: 'vercel-login',
  description: 'Vercel login via GitHub OAuth. Polling waits, no static post-nav sleeps.',
  params: {
    timeout_ms: 'overall timeout (default 60000)',
  },
  handle,
}