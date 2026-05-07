// macroHandlers/apple-signin.js
// Drive Apple ID sign-in on developer / appstoreconnect / icloud using Tate's
// Chrome session and Chrome autofill for the password.
//
// Wait/sleep discipline (Tate addendum 29 Apr 2026 15:08 AEST):
// - URL nav: waitForPageReady (change + settle), no static post-nav sleep
// - After clicking a field: 800-1500ms (autofill render)
// - After Enter on password: waitForPageReady (auth round-trip)
// - 2FA: pollFor2FA, return final screenshot to conductor
//
// Authored by fork_mojldsgx_7b55bf, 29 Apr 2026.

const { newTabAndNavigate, waitForPageReady, pollFor2FA } = require('./common')

const TARGETS = {
  developer: 'https://developer.apple.com/account/membership/',
  appstoreconnect: 'https://appstoreconnect.apple.com/',
  icloud: 'https://www.icloud.com/',
  developer_resources: 'https://developer.apple.com/account/resources/',
}

// Coordinates assume Chrome window approximating 1440x900 with the Apple ID
// widget centered. Drift detection is via screenshot inspection by the conductor.
const COORDS = {
  email_field:    { x: 720, y: 380 },
  email_continue: { x: 720, y: 440 },
  password_field: { x: 720, y: 380 },
  autofill_row:   { x: 720, y: 440 },
  trust_browser:  { x: 720, y: 540 },
  twofa_field:    { x: 720, y: 400 },
}

async function handle({ params, helpers }) {
  params = params || {}
  const target = params.target || 'developer'
  const url = TARGETS[target]
  if (!url) {
    return { success: false, error: `Unknown target: ${target}. Valid: ${Object.keys(TARGETS).join(', ')}` }
  }

  const email = params.email || 'code@ecodia.au'
  const code2fa = params.code2fa || null
  const timeoutMs = params.timeout_ms || 60000
  const startTs = Date.now()
  const deadline = startTs + timeoutMs
  const ttl = () => Math.max(deadline - Date.now(), 1000)

  helpers.note(`apple-signin start target=${target} url=${url} timeout_ms=${timeoutMs}`)
  helpers.mark('start')

  // Step 1: open tab + navigate. Polling-based page-ready wait inside.
  await newTabAndNavigate(helpers, url, { changeMaxMs: Math.min(10000, ttl()), settleMaxMs: Math.min(8000, ttl()) })
  helpers.mark('after_nav')

  // Step 2: idempotency baseline screenshot.
  const preShot = await helpers.screenshot.screenshot({ format: 'png' })
  helpers.mark('after_pre_screenshot')

  // Step 3: focus email, replace any prefilled value, submit.
  await helpers.input.click({ x: COORDS.email_field.x, y: COORDS.email_field.y })
  await helpers.sleep(1000) // field focus + any tooltip render
  await helpers.input.shortcut({ keys: ['ctrl', 'a'] })
  await helpers.sleep(150)
  await helpers.input.type({ text: email, delay: 4 })
  await helpers.sleep(250)
  await helpers.input.key({ key: 'enter' })
  await waitForPageReady(helpers, { changeMaxMs: Math.min(8000, ttl()), settleMaxMs: Math.min(6000, ttl()) })
  helpers.mark('after_email_submit')

  // Step 4: focus password field, click Chrome autofill dropdown row.
  await helpers.input.click({ x: COORDS.password_field.x, y: COORDS.password_field.y })
  await helpers.sleep(1200) // autofill dropdown render
  await helpers.input.click({ x: COORDS.autofill_row.x, y: COORDS.autofill_row.y })
  await helpers.sleep(800)
  await helpers.input.key({ key: 'enter' })
  // Form submission - long wait for auth round-trip + redirect.
  await waitForPageReady(helpers, { changeMaxMs: Math.min(10000, ttl()), settleMaxMs: Math.min(8000, ttl()) })
  helpers.mark('after_password_submit')

  // Step 5: 2FA prompt may appear after sign-in. Poll for it.
  const twofaPoll = await pollFor2FA(helpers, 1000, Math.min(15000, ttl()))
  helpers.mark('after_2fa_poll')

  if (code2fa) {
    await helpers.input.click({ x: COORDS.twofa_field.x, y: COORDS.twofa_field.y })
    await helpers.sleep(1000)
    await helpers.input.type({ text: code2fa, delay: 30 })
    await helpers.sleep(500)
    await helpers.input.key({ key: 'enter' })
    await waitForPageReady(helpers, { changeMaxMs: Math.min(8000, ttl()), settleMaxMs: Math.min(6000, ttl()) })
    helpers.mark('after_2fa_submit')
  }

  // Step 6: trust-browser checkbox if visible. Best-effort.
  await helpers.input.click({ x: COORDS.trust_browser.x, y: COORDS.trust_browser.y })
  await helpers.sleep(1500)
  await waitForPageReady(helpers, { changeMaxMs: Math.min(6000, ttl()), settleMaxMs: Math.min(5000, ttl()) })
  helpers.mark('after_trust')

  const postShot = await helpers.screenshot.screenshot({ format: 'png' })
  helpers.mark('after_post_screenshot')

  return {
    success: true,
    target,
    url,
    needs_2fa: !code2fa,
    timeout_ms_used: timeoutMs,
    elapsed_ms: Date.now() - startTs,
    twofa_poll: twofaPoll,
    preScreenshot: preShot && preShot.image ? `${(preShot.image || '').length} bytes b64` : null,
    postScreenshot: postShot && postShot.image ? `${(postShot.image || '').length} bytes b64` : null,
    note: 'Verify success by inspecting postScreenshot. If 2FA prompt appears and code2fa was not passed, conductor must fetch creds.apple_2fa_code or escalate.',
  }
}

module.exports = {
  name: 'apple-signin',
  description: 'Apple ID sign-in via Chrome autofill on developer / appstoreconnect / icloud / developer_resources. Polling waits, no static post-nav sleeps.',
  params: {
    target: 'developer | appstoreconnect | icloud | developer_resources (default: developer)',
    email: 'email to type (default: code@ecodia.au)',
    code2fa: 'optional 2FA code; if not provided, macro returns the 2FA-prompt screenshot for the conductor to handle',
    timeout_ms: 'overall timeout (default 60000)',
  },
  handle,
}