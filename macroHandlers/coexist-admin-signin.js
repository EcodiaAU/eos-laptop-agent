// macroHandlers/coexist-admin-signin.js
// Sign in to Co-Exist admin app via Chrome autofill on the saved admin cred.
//
// Wait discipline: polling waits via waitForPageReady. No static post-nav sleeps.
// Authored by fork_mojldsgx_7b55bf, 29 Apr 2026.

const { newTabAndNavigate, waitForPageReady } = require('./common')

const COORDS = {
  email_field:    { x: 720, y: 380 },
  password_field: { x: 720, y: 450 },
  autofill_row:   { x: 720, y: 510 },
  signin_button:  { x: 720, y: 540 },
}

async function handle({ params, helpers }) {
  params = params || {}
  const url = params.url || 'https://app.coexistaus.org/login'
  const email = params.email || null
  const timeoutMs = params.timeout_ms || 60000
  const startTs = Date.now()
  const deadline = startTs + timeoutMs
  const ttl = () => Math.max(deadline - Date.now(), 1000)

  helpers.note(`coexist-admin-signin start url=${url} email=${email ? '[set]' : '[not provided]'} timeout_ms=${timeoutMs}`)
  helpers.mark('start')

  await newTabAndNavigate(helpers, url, { changeMaxMs: Math.min(10000, ttl()), settleMaxMs: Math.min(8000, ttl()) })
  helpers.mark('after_nav')

  const preShot = await helpers.screenshot.screenshot({ format: 'png' })
  helpers.mark('after_pre_screenshot')

  // Email field
  await helpers.input.click({ x: COORDS.email_field.x, y: COORDS.email_field.y })
  await helpers.sleep(1000)
  if (email) {
    await helpers.input.shortcut({ keys: ['ctrl', 'a'] })
    await helpers.sleep(150)
    await helpers.input.type({ text: email, delay: 4 })
    await helpers.sleep(250)
  }
  helpers.mark('after_email_field')

  // Password field then autofill dropdown
  await helpers.input.click({ x: COORDS.password_field.x, y: COORDS.password_field.y })
  await helpers.sleep(1200) // autofill dropdown render
  await helpers.input.click({ x: COORDS.autofill_row.x, y: COORDS.autofill_row.y })
  await helpers.sleep(800)
  helpers.mark('after_autofill_click')

  // Submit
  await helpers.input.key({ key: 'enter' })
  await waitForPageReady(helpers, { changeMaxMs: Math.min(10000, ttl()), settleMaxMs: Math.min(8000, ttl()) })
  helpers.mark('after_submit')

  const postShot = await helpers.screenshot.screenshot({ format: 'png' })
  helpers.mark('after_post_screenshot')

  return {
    success: true,
    url,
    expected_final_url_contains: 'app.coexistaus.org',
    timeout_ms_used: timeoutMs,
    elapsed_ms: Date.now() - startTs,
    preScreenshot: preShot && preShot.image ? `${(preShot.image || '').length} bytes b64` : null,
    postScreenshot: postShot && postShot.image ? `${(postShot.image || '').length} bytes b64` : null,
    note: 'Verify dashboard via postScreenshot. If autofill row is not the saved admin cred, set email param explicitly and re-run.',
  }
}

module.exports = {
  name: 'coexist-admin-signin',
  description: 'Co-Exist admin sign-in via Chrome autofill. Polling waits.',
  params: {
    url: 'override login URL (default: https://app.coexistaus.org/login)',
    email: 'optional email to type before triggering autofill',
    timeout_ms: 'overall timeout (default 60000)',
  },
  handle,
}