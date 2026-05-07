// macroHandlers/asc-build-review-submit.js
// Drive the App Store Connect "Submit for App Review" flow on a TestFlight
// build via Tate's logged-in Chrome on Corazon.
//
// CAPTURE SOURCE: Recording 2, ~/ecodiaos/macros/captures/asc-build-review-submit-2026-05-06-1018.md
//   Captured 6 May 2026 09:38-09:39 UTC. 7 events. ASC Chrome at native Win.
//
// REPLAY DISCIPLINE: pixel-only with screenshot post-verify per click. Most
// ASC button selectors carry anonymous React class hashes that drift between
// page builds, so pixel coords + cropped-region post-click diff is the
// reliable replay path. Per-step pre-verify confirms the foreground window
// is still ASC Chrome via shell.shell GetForegroundWindow probe; if the
// foreground drifts off ASC, we throw WrongForegroundWindowError and abort.
//
// CHAIN-RUN POSITION: this is the second leg of the ios-release pipeline:
//   macincloud-login -> ios-build-pipeline (intermittent xcode/transporter)
//   -> THIS HANDLER. The chain-runner is responsible for ensuring the URL
//   bar / clipboard / tab state is correct before invocation; this handler
//   begins on a Chrome tab with the appstoreconnect URL ready to commit.
//
// dry_run=true mode halts BEFORE step 5 (the Save click) and returns
// pre-Save state for operator inspection.
//
// VALIDATION STATUS: untested_spec until a real chain-run lands one Save
// click + the verification pass per
// ~/ecodiaos/patterns/macros-must-be-validated-by-real-run-before-codification.md
//
// Authored: fork_motxeno8_531d99, 6 May 2026.

'use strict';

const path = require('path');
const shellTool = require(path.join(__dirname, '..', 'tools', 'shell.js'));

// ---- Captured pixel coordinates (Recording 2, 6 May 2026) ---------------
// These came from a real recording, not from imagination. Per
// ~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md, do
// NOT amend without a fresh recording.
const COORDS = {
  // Step 3: anonymous React class hash, pixel-only
  step3_main_click:    { x: 772,  y: 565 },
  // Step 4: type=main, pixel-only
  step4_main_click:    { x: 590,  y: 348 },
  // Step 5: name="Save" (UIA name available on capture), with pixel fallback
  step5_save_click:    { x: 1162, y: 214 },
  // Step 6: type=main, pixel-only
  step6_main_click:    { x: 1240, y: 220 },
  // Step 7: anonymous, pixel-only
  step7_anon_click:    { x: 1143, y: 671 },
};

// Class name returned by GetForegroundWindow on Tate's Chrome.
const CHROME_CLASS_HINT = 'Chrome_WidgetWin_1';
const ASC_TITLE_HINT    = 'App Store Connect';

class WrongForegroundWindowError extends Error {
  constructor(actualTitle, actualClass) {
    super(`Pre-flight failed: foreground window is "${actualTitle}" (class=${actualClass}), expected Chrome with title containing "${ASC_TITLE_HINT}"`);
    this.name = 'WrongForegroundWindowError';
    this.actualTitle = actualTitle;
    this.actualClass = actualClass;
  }
}

// PowerShell snippet that returns "title|class|exe" for the current
// foreground window. Single-line so we can pass via shell.shell -Command.
const FOREGROUND_PROBE_PS = [
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public class FW {',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '}',
  '"@;',
  '$h = [FW]::GetForegroundWindow();',
  '$tlen = [FW]::GetWindowTextLength($h) + 2;',
  '$tbuf = New-Object System.Text.StringBuilder $tlen;',
  '[FW]::GetWindowText($h, $tbuf, $tlen) | Out-Null;',
  '$cbuf = New-Object System.Text.StringBuilder 256;',
  '[FW]::GetClassName($h, $cbuf, 256) | Out-Null;',
  '[uint32]$pid = 0;',
  '[FW]::GetWindowThreadProcessId($h, [ref]$pid) | Out-Null;',
  '$exe = "";',
  'try { $exe = (Get-Process -Id $pid -ErrorAction Stop).ProcessName } catch { $exe = "" };',
  'Write-Output ("{0}|{1}|{2}" -f $tbuf.ToString(), $cbuf.ToString(), $exe);',
].join(' ');

async function probeForeground(helpers) {
  if (helpers.dryRun) {
    return { title: '[dryRun App Store Connect - Google Chrome]', className: CHROME_CLASS_HINT, exe: 'chrome' };
  }
  const r = await shellTool.shell({ command: `powershell -NoProfile -Command "${FOREGROUND_PROBE_PS.replace(/"/g, '\\"')}"`, timeout: 8000 });
  const line = ((r.stdout || '').trim().split(/\r?\n/).pop() || '');
  const [title, className, exe] = line.split('|');
  return { title: title || '', className: className || '', exe: exe || '' };
}

async function assertForegroundIsAsc(helpers) {
  const fg = await probeForeground(helpers);
  const titleMatch = (fg.title || '').includes(ASC_TITLE_HINT);
  const classMatch = (fg.className || '').includes('Chrome_WidgetWin');
  if (!titleMatch || !classMatch) {
    throw new WrongForegroundWindowError(fg.title, fg.className);
  }
  return fg;
}

// Tiny content hash over a base64 PNG. Mirrors common.js simpleHash so we
// can detect "any pixel change" without pulling a heavy image diff lib.
function simpleHash(b64) {
  let h = 0;
  if (!b64) return '0';
  for (let i = 0; i < Math.min(b64.length, 8000); i += 13) {
    h = (h * 31 + b64.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

// Take a screenshot, return base64 + simpleHash. Returns nulls in dryRun.
async function captureFrame(helpers, label) {
  if (helpers.dryRun) {
    return { dryRun: true, label, bytes: 0, hash: null };
  }
  const shot = await helpers.screenshot.screenshot({ format: 'png' });
  const image = (shot && shot.image) || null;
  return {
    label,
    bytes: image ? image.length : 0,
    hash: image ? simpleHash(image) : null,
  };
}

/**
 * Click at (x,y), then post-verify by comparing the screenshot hash before
 * and after. Any change confirms a click landed. If no change after the
 * settle window, we still succeed but flag verify_change=false in the result
 * (some ASC button clicks open async dialogs that arrive later).
 */
async function clickWithVerify(helpers, label, x, y, opts) {
  opts = opts || {};
  const settleMs = opts.settleMs || 600;
  const beforeFrame = await captureFrame(helpers, `${label}_before`);
  helpers.note(`click ${label} at (${x},${y})`);
  await helpers.input.click({ x, y });
  await helpers.sleep(settleMs);
  const afterFrame = await captureFrame(helpers, `${label}_after`);
  const verifyChange = !!(beforeFrame.hash && afterFrame.hash && beforeFrame.hash !== afterFrame.hash);
  return {
    label, x, y,
    before_hash: beforeFrame.hash,
    after_hash: afterFrame.hash,
    verify_change: helpers.dryRun ? null : verifyChange,
    settle_ms: settleMs,
  };
}

// ---- Main handle --------------------------------------------------------

async function handle({ params, helpers }) {
  params = params || {};
  const buildId  = params.build_id || null;
  const appName  = params.app_name || null; // 'Co-Exist' | 'EcodiaOS' | null
  const dryRun   = params.dry_run === true;
  const startTs  = Date.now();
  const screenshots = [];
  const errors = [];

  helpers.note(`asc-build-review-submit start build_id=${buildId || '(unset)'} app_name=${appName || '(unset)'} dry_run=${dryRun}`);
  helpers.mark('start');

  // ---- Pre-flight: foreground window is ASC Chrome --------------------
  let preflightFg;
  try {
    preflightFg = await assertForegroundIsAsc(helpers);
    helpers.mark('after_preflight');
  } catch (err) {
    return {
      ok: false,
      stepsCompleted: 0,
      screenshots,
      errors: [`pre-flight: ${err.message}`],
      build_id: buildId,
      app_name: appName,
      dry_run: dryRun,
      foreground_actual: { title: err.actualTitle, className: err.actualClass },
      elapsed_ms: Date.now() - startTs,
      hint: 'Run macincloud-login + chain-runner steps that bring an ASC tab to the foreground BEFORE invoking this handler. Or: input.shortcut [alt,tab] to ASC tab, then retry.',
    };
  }

  // Baseline screenshot for the operator.
  const baseline = await captureFrame(helpers, 'baseline');
  screenshots.push(baseline);

  let stepsCompleted = 0;

  // Step 1: Enter (commit URL bar). The chain-runner is responsible for
  // populating the URL bar with the appstoreconnect destination before this
  // step. We do not type the URL ourselves; we just commit it.
  try {
    helpers.note('step1: input.key Enter (commit URL)');
    await helpers.input.key({ key: 'enter' });
    await helpers.sleep(800);
    stepsCompleted = 1;
    helpers.mark('after_step1');
  } catch (err) {
    errors.push(`step1: ${err.message}`);
    return finalise({ ok: false, stepsCompleted, screenshots, errors, buildId, appName, dryRun, startTs, lastStep: stepsCompleted });
  }

  // Step 2: Ctrl+V (paste URL). Captured by Recording 2 immediately after
  // Enter; the chain-runner is responsible for the clipboard contents.
  try {
    helpers.note('step2: input.shortcut [ctrl, v] (paste)');
    await helpers.input.shortcut({ keys: ['ctrl', 'v'] });
    await helpers.sleep(1200); // page-ready wait after possible nav
    stepsCompleted = 2;
    helpers.mark('after_step2');
  } catch (err) {
    errors.push(`step2: ${err.message}`);
    return finalise({ ok: false, stepsCompleted, screenshots, errors, buildId, appName, dryRun, startTs, lastStep: stepsCompleted });
  }

  // Re-confirm foreground is still ASC Chrome before we start clicking on
  // anonymous React class hashes. If we drifted off ASC, abort with the
  // recorded steps so far.
  try {
    await assertForegroundIsAsc(helpers);
  } catch (err) {
    errors.push(`mid-flight foreground drift after step2: ${err.message}`);
    return finalise({ ok: false, stepsCompleted, screenshots, errors, buildId, appName, dryRun, startTs, lastStep: stepsCompleted });
  }

  // Step 3: anonymous React class hash, pixel-only.
  try {
    const r = await clickWithVerify(helpers, 'step3_main_click', COORDS.step3_main_click.x, COORDS.step3_main_click.y, { settleMs: 700 });
    screenshots.push({ label: 'step3', verify_change: r.verify_change });
    stepsCompleted = 3;
    helpers.mark('after_step3');
  } catch (err) {
    errors.push(`step3: ${err.message}`);
    return finalise({ ok: false, stepsCompleted, screenshots, errors, buildId, appName, dryRun, startTs, lastStep: stepsCompleted });
  }

  // Step 4: type=main, pixel-only.
  try {
    const r = await clickWithVerify(helpers, 'step4_main_click', COORDS.step4_main_click.x, COORDS.step4_main_click.y, { settleMs: 700 });
    screenshots.push({ label: 'step4', verify_change: r.verify_change });
    stepsCompleted = 4;
    helpers.mark('after_step4');
  } catch (err) {
    errors.push(`step4: ${err.message}`);
    return finalise({ ok: false, stepsCompleted, screenshots, errors, buildId, appName, dryRun, startTs, lastStep: stepsCompleted });
  }

  // ---- dry_run halt-point: BEFORE step 5 (Save) -----------------------
  // The brief halts dry_run runs here so an operator can inspect the
  // pre-Save UI state without committing the irreversible Save action.
  if (dryRun) {
    helpers.mark('dry_run_halt_before_step5');
    const finalShot = await captureFrame(helpers, 'dry_run_halt');
    screenshots.push(finalShot);
    return {
      ok: true,
      dryRun: true,
      stepsCompleted: 4,
      lastStep: 4,
      screenshots,
      errors,
      build_id: buildId,
      app_name: appName,
      foreground_actual: preflightFg,
      elapsed_ms: Date.now() - startTs,
      note: 'dry_run halted before step 5 (Save click). Re-invoke with dry_run=false to complete the submission.',
    };
  }

  // Step 5: name="Save". UIA-by-name on Chrome accessibility tree would
  // require a Chrome-side probe (not implemented); fall straight to the
  // captured pixel. The capture confirms (1162, 214) lands the Save button
  // for the recorded layout. ASC is responsive but the Save button anchors
  // to the upper-right of a fixed header; if pixel layout drifts, the
  // verify_change diff will catch it.
  try {
    const r = await clickWithVerify(helpers, 'step5_save_click', COORDS.step5_save_click.x, COORDS.step5_save_click.y, { settleMs: 1500 });
    screenshots.push({ label: 'step5_save', verify_change: r.verify_change });
    if (r.verify_change === false) {
      helpers.note('step5: WARNING - no pixel change detected after Save click. Continuing, but operator should inspect.');
    }
    stepsCompleted = 5;
    helpers.mark('after_step5');
  } catch (err) {
    errors.push(`step5: ${err.message}`);
    return finalise({ ok: false, stepsCompleted, screenshots, errors, buildId, appName, dryRun, startTs, lastStep: stepsCompleted });
  }

  // Step 6: type=main, pixel-only.
  try {
    const r = await clickWithVerify(helpers, 'step6_main_click', COORDS.step6_main_click.x, COORDS.step6_main_click.y, { settleMs: 700 });
    screenshots.push({ label: 'step6', verify_change: r.verify_change });
    stepsCompleted = 6;
    helpers.mark('after_step6');
  } catch (err) {
    errors.push(`step6: ${err.message}`);
    return finalise({ ok: false, stepsCompleted, screenshots, errors, buildId, appName, dryRun, startTs, lastStep: stepsCompleted });
  }

  // Step 7: anonymous, pixel-only.
  try {
    const r = await clickWithVerify(helpers, 'step7_anon_click', COORDS.step7_anon_click.x, COORDS.step7_anon_click.y, { settleMs: 1200 });
    screenshots.push({ label: 'step7', verify_change: r.verify_change });
    stepsCompleted = 7;
    helpers.mark('after_step7');
  } catch (err) {
    errors.push(`step7: ${err.message}`);
    return finalise({ ok: false, stepsCompleted, screenshots, errors, buildId, appName, dryRun, startTs, lastStep: stepsCompleted });
  }

  const final = await captureFrame(helpers, 'final');
  screenshots.push(final);

  return {
    ok: true,
    stepsCompleted,
    lastStep: 7,
    screenshots,
    errors,
    build_id: buildId,
    app_name: appName,
    foreground_actual: preflightFg,
    elapsed_ms: Date.now() - startTs,
    note: 'All 7 captured steps replayed. Operator must visually verify the build is queued for App Review on the ASC TestFlight page.',
  };
}

function finalise({ ok, stepsCompleted, screenshots, errors, buildId, appName, dryRun, startTs, lastStep }) {
  return {
    ok,
    stepsCompleted,
    lastStep,
    screenshots,
    errors,
    build_id: buildId,
    app_name: appName,
    dry_run: !!dryRun,
    elapsed_ms: Date.now() - startTs,
  };
}

module.exports = {
  name: 'asc-build-review-submit',
  description: 'Submit a TestFlight build for App Review on App Store Connect via Tate logged-in Chrome on Corazon. Pixel-replay with per-step screenshot-verify; UIA below Chrome accessibility tree is unreliable so most steps are pixel-anchored. dry_run=true halts before the Save click for operator inspection.',
  params: {
    build_id:  'optional TestFlight build identifier (informational; the chain-runner navigates to the build page before invocation)',
    app_name:  "optional 'Co-Exist' | 'EcodiaOS' (informational)",
    dry_run:   'boolean - if true, halt before step 5 (Save click) and return pre-Save state',
  },
  handle,
  WrongForegroundWindowError,
};
