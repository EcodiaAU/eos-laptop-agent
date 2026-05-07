// runbook.js - persistent JSON runbook primitive + replay executor.
//
// runbook.save({ name, steps, vision_targets?, validations?, description?, goal_state?, authored_by? })
//   -> { id, name, version, authored_at }
// runbook.load({ name }) -> full row (including steps + vision_targets + validations)
// runbook.list() -> array of runbook metadata (not full steps)
// runbook.recordOutcome({ name, outcome }) -> { name, last_run_at, last_run_outcome }
// runbook.run({ name, mode?='live'|'dry', context?, fork_id? })
//   -> { run_id, runbook, terminal_state: 'complete'|'fail'|'abort'|'pause_question'|'pause_credential',
//        observations: [...], context, reason? }
//
// Schema:
//   steps:  [{ action, params, on_failure? }]
//     action ∈ click|type|shortcut|wait|screenshot|verify|shell|abort.check
//   vision_targets: [{ name, target_description, expected_bbox? }]
//   validations:    [{ type, expected }]
//
// shell action params:
//   { command, cwd?, timeout_ms?, on_nonzero_exit?: 'abort'|'continue'|'ask', capture_to? }
// abort.check action params:
//   { run_id, on_abort?: 'halt' | 'rollback_to_step:<N>' }
//
// Replay safety:
//   - Steps with intent=type_secret_from_kv ALWAYS surface to conductor + halt.
//     The agent never reads kv_store. Credential typing is a conductor
//     responsibility (out of band from the runbook engine).
//
// Shipped 29 Apr 2026 (fork_mojsk7dl_c4424f).
// shell + abort.check vocabulary added 29 Apr 2026 (fork_mojuu72x_5decc8).
// runbook.run executor added 29 Apr 2026 (fork_mojvd0vu_b2f9ae).

const screenshotMod = require('./screenshot');
const inputMod = require('./input');
const visionMod = require('./vision');
const questionMod = require('./question');
const shellMod = require('./shell');

const BACKEND_URL = process.env.ECODIAOS_BACKEND_URL || 'https://api.admin.ecodia.au';

const VALID_ACTIONS = new Set([
  'click', 'type', 'shortcut', 'wait', 'screenshot', 'verify',
  'shell', 'abort.check',
]);
const VALID_NONZERO_EXIT = new Set(['abort', 'continue', 'ask']);

function _validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return 'steps must be a non-empty array';
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s || typeof s !== 'object') return `step ${i} must be an object`;
    if (!VALID_ACTIONS.has(s.action)) return `step ${i}.action must be one of ${[...VALID_ACTIONS].join('|')}`;
    if (s.params && typeof s.params !== 'object') return `step ${i}.params must be an object`;
    if (s.on_failure && !['abort', 'retry', 'ask'].includes(s.on_failure)) return `step ${i}.on_failure must be abort|retry|ask`;
    if (s.action === 'shell') {
      const p = s.params || {};
      if (!p.command || typeof p.command !== 'string') return `step ${i} (shell): params.command (string) required`;
      if (p.cwd !== undefined && typeof p.cwd !== 'string') return `step ${i} (shell): params.cwd must be a string`;
      if (p.timeout_ms !== undefined && (typeof p.timeout_ms !== 'number' || p.timeout_ms <= 0)) return `step ${i} (shell): params.timeout_ms must be a positive number`;
      if (p.on_nonzero_exit !== undefined && !VALID_NONZERO_EXIT.has(p.on_nonzero_exit)) return `step ${i} (shell): params.on_nonzero_exit must be one of ${[...VALID_NONZERO_EXIT].join('|')}`;
      if (p.capture_to !== undefined && typeof p.capture_to !== 'string') return `step ${i} (shell): params.capture_to must be a string`;
    } else if (s.action === 'abort.check') {
      const p = s.params || {};
      if (!p.run_id || typeof p.run_id !== 'string') return `step ${i} (abort.check): params.run_id (string) required`;
      if (p.on_abort !== undefined) {
        if (typeof p.on_abort !== 'string') return `step ${i} (abort.check): params.on_abort must be a string`;
        if (p.on_abort !== 'halt' && !p.on_abort.startsWith('rollback_to_step:')) return `step ${i} (abort.check): params.on_abort must be 'halt' or 'rollback_to_step:<N>'`;
      }
    }
  }
  return null;
}

async function _req(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(`${BACKEND_URL}${path}`, opts);
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${method} ${path} -> ${resp.status}: ${text.slice(0, 400)}`);
  try { return JSON.parse(text); } catch { throw new Error(`${method} ${path} returned non-JSON: ${text.slice(0, 200)}`); }
}

async function save(params) {
  const { name, steps, vision_targets, validations, description, goal_state, authored_by } = params || {};
  if (!name || typeof name !== 'string') throw new Error('runbook.save: name (string) required');
  const stepsErr = _validateSteps(steps);
  if (stepsErr) throw new Error(`runbook.save: ${stepsErr}`);
  return _req('POST', '/api/runbooks', { name, steps, vision_targets, validations, description, goal_state, authored_by });
}

async function load(params) {
  const { name } = params || {};
  if (!name) throw new Error('runbook.load: name required');
  return _req('GET', `/api/runbooks/${encodeURIComponent(name)}`);
}

async function list() {
  return _req('GET', '/api/runbooks');
}

async function recordOutcome(params) {
  const { name, outcome } = params || {};
  if (!name) throw new Error('runbook.recordOutcome: name required');
  if (!outcome || typeof outcome !== 'string') throw new Error('runbook.recordOutcome: outcome (string) required');
  return _req('PATCH', `/api/runbooks/${encodeURIComponent(name)}/run-outcome`, { outcome });
}

// ---------------------------------------------------------------------------
// Replay executor
// ---------------------------------------------------------------------------

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _findStepIndex(runbook, logical_index) {
  const steps = runbook.steps || [];
  for (let i = 0; i < steps.length; i++) {
    if ((steps[i].params || {}).step_logical_index === logical_index) return i;
  }
  return -1;
}

function _readContextRef(context, ref) {
  if (!ref) return undefined;
  const key = String(ref).replace(/^context\./, '');
  return context[key];
}

async function _captureShot() {
  const shot = await screenshotMod.screenshot({});
  const img = shot && (shot.image || shot.base64 || shot.data);
  return { image: img, format: shot && shot.format };
}

async function _visionLocate(target, expected_count, screenshot_base64) {
  return visionMod.locate({ target, expected_count, screenshot_base64 });
}

async function _executeStep(step, context, runbook, runMeta) {
  const a = step.action;
  const p = step.params || {};
  const intent = p.intent;

  // SAFETY GUARD: never type secrets autonomously. Surface + halt.
  if (a === 'type' && intent === 'type_secret_from_kv') {
    let qid = null;
    try {
      const q = await questionMod.surface({
        question: p.on_missing_question || `runbook ${runMeta.name} step ${p.step_logical_index}: type_secret_from_kv (${p.secret_ref}) reached. Conductor: provide value or set kv_store row, then resume.`,
        fork_id: runMeta.fork_id || null,
        context: { runbook: runMeta.name, step: p.step_logical_index, secret_ref: p.secret_ref, run_id: runMeta.run_id },
        deliver_via: 'chat',
      });
      qid = q && q.id;
    } catch (e) { /* surface failure - still abort */ }
    return {
      outcome: 'pause_credential',
      terminal: 'abort',
      reason: `credential step ${p.step_logical_index} requires conductor input (secret_ref=${p.secret_ref}). Question id=${qid || 'surface_failed'}.`,
      question_id: qid,
    };
  }

  // skip_if_state guard (works on most action types)
  if (p.skip_if_state) {
    const refKey = String(p.classification_ref || 'context.post_login_state').replace(/^context\./, '');
    if (context[refKey] === p.skip_if_state) {
      return { outcome: 'skipped', reason: `skip_if_state matched: ${refKey}=${p.skip_if_state}` };
    }
  }

  if (a === 'screenshot') {
    if (intent === 'state_assess') {
      const r = await _captureShot();
      return { outcome: 'pass', notes: 'screenshot captured', screenshot_format: r.format, screenshot_bytes: (r.image || '').length };
    }
    if (intent === 'vision_locate') {
      const target = p.target_description || p.target;
      if (!target) throw new Error('vision_locate: target_description required');
      const shot = await _captureShot();
      const r = await _visionLocate(target, p.expect_count, shot.image);
      const matches = (r && r.matches) || [];
      const writes = {};
      const top = matches[0];
      const conf = top ? (top.confidence || 0) : 0;
      const min_conf = p.min_confidence || 0;
      const located = matches.length > 0 && conf >= min_conf;
      writes[`vision.${p.vision_target_id}`] = located
        ? { located: true, x: top.x, y: top.y, confidence: top.confidence, label: top.label, bbox: top.bbox }
        : { located: false, reason: matches.length === 0 ? 'no_matches' : 'below_min_confidence', top_confidence: conf, min_confidence: min_conf };
      if (!located) {
        return {
          outcome: 'fail',
          reason: matches.length === 0 ? 'vision.locate returned no matches' : `top confidence ${conf} < min_confidence ${min_conf}`,
          context_writes: writes,
          vision_response_summary: { match_count: matches.length, top_confidence: conf, reasoning_excerpt: (r && r.reasoning ? String(r.reasoning).slice(0, 300) : null) },
        };
      }
      return {
        outcome: 'pass',
        located: true,
        coords: { x: top.x, y: top.y },
        confidence: top.confidence,
        label: top.label,
        context_writes: writes,
      };
    }
    if (intent === 'branch_classify') {
      const target = p.target_description || p.target;
      if (!target) throw new Error('branch_classify: target_description required');
      const shot = await _captureShot();
      const r = await _visionLocate(target, p.expect_count, shot.image);
      const matches = (r && r.matches) || [];
      const reasoning = (r && r.reasoning) ? String(r.reasoning).toLowerCase() : '';
      const labelText = matches.map(m => (m.label || '').toLowerCase()).join(' ');
      let classification = 'unknown';
      let bestConf = 0;
      for (const cls of (p.classify_into || [])) {
        const cl = String(cls).toLowerCase();
        const variants = [cl, cl.replace(/_/g, ' '), cl.replace(/_/g, '')];
        for (const v of variants) {
          if (labelText.includes(v) || reasoning.includes(v)) {
            // pick the matching candidate confidence if available, else 0.7 baseline
            const matchedM = matches.find(m => (m.label || '').toLowerCase().includes(v));
            const c = matchedM ? (matchedM.confidence || 0) : 0.7;
            if (c > bestConf) { bestConf = c; classification = cls; }
          }
        }
      }
      const storeKey = String(p.store_classification_as || 'context.post_login_state').replace(/^context\./, '');
      const writes = {};
      writes[storeKey] = classification;
      const ok = classification !== 'unknown' && bestConf >= (p.min_confidence || 0);
      return {
        outcome: ok ? 'pass' : 'fail',
        classification,
        classification_confidence: bestConf,
        context_writes: writes,
        vision_response_summary: { match_count: matches.length, reasoning_excerpt: reasoning.slice(0, 300) },
      };
    }
    if (intent === 'vision_verify') {
      const target = p.target_description || p.target;
      const shot = await _captureShot();
      const r = await _visionLocate(target, p.expect_count, shot.image);
      const matches = (r && r.matches) || [];
      const top = matches[0];
      const present = matches.length > 0 && (top.confidence || 0) >= (p.min_confidence || 0);
      let absentOk = true;
      let absentResult = null;
      if (p.absent_check && p.absent_check.must_be_absent) {
        const absShot = await _captureShot();
        const absR = await _visionLocate(p.absent_check.target_description, undefined, absShot.image);
        const absMatches = (absR && absR.matches) || [];
        const absTop = absMatches[0];
        if (absMatches.length > 0 && (absTop.confidence || 0) >= 0.7) absentOk = false;
        absentResult = { match_count: absMatches.length, top_confidence: absTop ? absTop.confidence : 0 };
      }
      const verified = present && absentOk;
      return {
        outcome: verified ? 'pass' : 'fail',
        verified,
        present,
        absent_ok: absentOk,
        present_confidence: top ? top.confidence : 0,
        absent_result: absentResult,
      };
    }
    throw new Error(`screenshot intent not implemented: ${intent}`);
  }

  if (a === 'shortcut') {
    if (!Array.isArray(p.keys)) throw new Error('shortcut: keys array required');
    await inputMod.shortcut({ keys: p.keys });
    if (p.then_type) {
      await _sleep(150);
      await inputMod.type({ text: p.then_type });
    }
    if (p.then_key) {
      await _sleep(150);
      await inputMod.key({ key: p.then_key });
    }
    if (p.wait_after_ms) await _sleep(p.wait_after_ms);
    return { outcome: 'pass', notes: `shortcut ${p.keys.join('+')}${p.then_type ? ' + type' : ''}${p.then_key ? ' + ' + p.then_key : ''}` };
  }

  if (a === 'click') {
    if (intent === 'click_located') {
      const sourceStep = p.source_step;
      const srcStep = (runbook.steps || []).find(s => (s.params || {}).step_logical_index === sourceStep);
      if (!srcStep) throw new Error(`click_located: source_step ${sourceStep} not found`);
      const targetId = (srcStep.params || {}).vision_target_id;
      const visionEntry = context[`vision.${targetId}`];
      if (!visionEntry || !visionEntry.located) {
        throw new Error(`click_located: vision target ${targetId} (from step ${sourceStep}) not located in context`);
      }
      await inputMod.click({ x: visionEntry.x, y: visionEntry.y, button: p.click_type === 'right' ? 'right' : 'left' });
      if (p.wait_after_ms) await _sleep(p.wait_after_ms);
      return { outcome: 'pass', clicked_at: { x: visionEntry.x, y: visionEntry.y } };
    }
    if (typeof p.x === 'number' && typeof p.y === 'number') {
      await inputMod.click({ x: p.x, y: p.y, button: p.click_type === 'right' ? 'right' : 'left' });
      if (p.wait_after_ms) await _sleep(p.wait_after_ms);
      return { outcome: 'pass', clicked_at: { x: p.x, y: p.y } };
    }
    throw new Error(`click intent not implemented: ${intent}`);
  }

  if (a === 'type') {
    if (intent === 'vision_locate_and_type') {
      const target = p.target_description || (runbook.vision_targets || []).find(v => v.name === p.vision_target_id)?.target_description;
      if (!target) throw new Error('vision_locate_and_type: no target_description available');
      const shot = await _captureShot();
      const r = await _visionLocate(target, undefined, shot.image);
      const matches = (r && r.matches) || [];
      const top = matches[0];
      const conf = top ? (top.confidence || 0) : 0;
      if (!top || conf < (p.min_confidence || 0.7)) {
        return { outcome: 'fail', reason: 'vision target not found or low confidence', top_confidence: conf };
      }
      await inputMod.click({ x: top.x, y: top.y });
      await _sleep(200);
      let text = p.text_template || p.text || '';
      text = text.replace(/\{context\.([\w.]+)\}/g, (_, k) => {
        const v = context[k];
        return v != null ? String(v) : '';
      });
      if (!text) return { outcome: 'fail', reason: 'no text resolved from text_template' };
      await inputMod.type({ text });
      if (p.press_after) {
        await _sleep(150);
        await inputMod.key({ key: p.press_after });
      }
      if (p.wait_after_ms) await _sleep(p.wait_after_ms);
      return { outcome: 'pass' };
    }
    if (typeof p.text === 'string' && !intent) {
      await inputMod.type({ text: p.text });
      return { outcome: 'pass' };
    }
    throw new Error(`type intent not implemented: ${intent}`);
  }

  if (a === 'verify') {
    if (intent === 'branch_on_classification') {
      const refKey = String(p.classification_ref || 'context.post_login_state').replace(/^context\./, '');
      const cls = context[refKey];
      const branches = p.branches || {};
      const branch = branches[cls];
      if (!branch) {
        const onUnknown = p.on_unknown || 'abort_and_surface_to_conductor';
        if (onUnknown === 'abort_and_surface_to_conductor') {
          return { outcome: 'pause', terminal: 'abort', reason: `branch_on_classification: classification=${cls}, no actionable branch` };
        }
      }
      if (branch === 'abort_and_surface_to_conductor') {
        return { outcome: 'pause', terminal: 'abort', reason: `branch_on_classification: classification=${cls} -> abort_and_surface_to_conductor` };
      }
      const m1 = /^continue_to_step_(\d+)$/.exec(branch || '');
      const m2 = /^skip_to_step_(\d+)$/.exec(branch || '');
      if (m1) {
        const tgt = parseInt(m1[1], 10);
        const idx = _findStepIndex(runbook, tgt);
        if (idx < 0) return { outcome: 'fail', reason: `branch target step ${tgt} not found` };
        return { outcome: 'pass', branch, next_pointer: idx };
      }
      if (m2) {
        const tgt = parseInt(m2[1], 10);
        const idx = _findStepIndex(runbook, tgt);
        if (idx < 0) return { outcome: 'fail', reason: `branch target step ${tgt} not found` };
        return { outcome: 'pass', branch, next_pointer: idx };
      }
      return { outcome: 'pass', branch: branch || 'fallthrough' };
    }
    if (intent === 'question_surface') {
      let qid = null;
      try {
        const q = await questionMod.surface({
          question: p.question,
          fork_id: runMeta.fork_id || null,
          context: {
            runbook: runMeta.name,
            step: p.step_logical_index,
            run_id: runMeta.run_id,
            include_screenshot: !!p.include_screenshot,
            include_capture_ref: p.include_capture_ref,
            include_runbook_outcome: p.include_runbook_outcome,
          },
          deliver_via: 'chat',
          expires_in_seconds: p.timeout_seconds,
        });
        qid = q && q.id;
      } catch (e) { /* surface failure non-fatal */ }
      // we do not poll inside the executor v1 - the conductor decides whether to wait
      return { outcome: 'surfaced', question_id: qid };
    }
    if (intent === 'assert' || intent === 'static_assert') {
      // simple equality check on context ref
      const ref = p.context_ref;
      const expected = p.expected;
      const actual = _readContextRef(context, ref);
      const ok = actual === expected;
      return { outcome: ok ? 'pass' : 'fail', reason: ok ? null : `assert: expected ${ref}=${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` };
    }
    throw new Error(`verify intent not implemented: ${intent}`);
  }

  if (a === 'wait') {
    const ms = (p.ms || p.wait_ms || p.duration_ms || 500);
    await _sleep(ms);
    return { outcome: 'pass', waited_ms: ms };
  }

  if (a === 'shell') {
    const r = await shellMod.shell({ command: p.command, cwd: p.cwd, timeout: p.timeout_ms });
    const ok = r.exitCode === 0;
    if (!ok) {
      const policy = p.on_nonzero_exit || 'abort';
      if (policy === 'continue') return { outcome: 'pass', shell_exit: r.exitCode, stdout_excerpt: (r.stdout || '').slice(0, 300), stderr_excerpt: (r.stderr || '').slice(0, 300) };
      if (policy === 'abort') return { outcome: 'fail', terminal: 'abort', reason: `shell nonzero exit (${r.exitCode}): ${(r.stderr || '').slice(0, 300)}`, shell_exit: r.exitCode };
      // ask handled by step.on_failure pathway via fail outcome
      return { outcome: 'fail', shell_exit: r.exitCode, stderr_excerpt: (r.stderr || '').slice(0, 300) };
    }
    if (p.capture_to) {
      const writes = {};
      writes[String(p.capture_to).replace(/^context\./, '')] = (r.stdout || '').trim();
      return { outcome: 'pass', shell_exit: 0, context_writes: writes };
    }
    return { outcome: 'pass', shell_exit: 0, stdout_excerpt: (r.stdout || '').slice(0, 300) };
  }

  if (a === 'abort.check') {
    // v1: this is a no-op pass - the conductor pre-checks abort flags before resuming
    return { outcome: 'pass', notes: 'abort.check no-op in v1 executor' };
  }

  throw new Error(`unknown action: ${a}`);
}

async function run(params) {
  const { name, mode = 'live', context: initial_context = {}, dry = false, fork_id } = params || {};
  if (!name) throw new Error('runbook.run: name required');

  const rb = await load({ name });
  const log = [];
  let context = { ...initial_context };
  let pointer = 0;
  const steps = rb.steps || [];
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const runMeta = { name, fork_id, run_id: runId };
  const isDry = (dry === true) || (mode === 'dry');

  const startedAt = new Date().toISOString();

  while (pointer < steps.length) {
    const step = steps[pointer];
    const stepIdx = (step.params || {}).step_logical_index || (pointer + 1);
    const obs = {
      pointer,
      step_index: stepIdx,
      action: step.action,
      intent: (step.params || {}).intent || null,
      vision_target_id: (step.params || {}).vision_target_id || null,
      started_at: new Date().toISOString(),
    };

    if (isDry) {
      obs.outcome = 'dry_skip';
      obs.notes = `would execute action=${step.action} intent=${(step.params || {}).intent || 'none'}`;
      obs.completed_at = new Date().toISOString();
      log.push(obs);
      pointer += 1;
      continue;
    }

    let result;
    try {
      result = await _executeStep(step, context, rb, runMeta);
    } catch (err) {
      obs.outcome = 'error';
      obs.error_message = err.message;
      const onFailure = step.on_failure || 'abort';
      obs.on_failure_policy = onFailure;
      obs.completed_at = new Date().toISOString();
      log.push(obs);
      if (onFailure === 'ask') {
        return { run_id: runId, runbook: name, started_at: startedAt, terminal_state: 'pause_question', reason: `step ${stepIdx} (${step.action}/${(step.params || {}).intent}) error -> on_failure=ask: ${err.message}`, observations: log, context };
      }
      // abort or unknown
      return { run_id: runId, runbook: name, started_at: startedAt, terminal_state: 'fail', reason: `step ${stepIdx} (${step.action}/${(step.params || {}).intent}) error: ${err.message}`, observations: log, context };
    }

    obs.outcome = result.outcome || 'pass';
    obs.result_summary = {};
    for (const k of Object.keys(result)) {
      if (k === 'context_writes') continue;
      const v = result[k];
      if (typeof v === 'string' && v.length > 600) obs.result_summary[k] = v.slice(0, 600) + '...';
      else obs.result_summary[k] = v;
    }
    if (result.context_writes) {
      for (const [k, v] of Object.entries(result.context_writes)) context[k] = v;
      obs.context_writes_keys = Object.keys(result.context_writes);
    }

    if (result.terminal === 'abort') {
      obs.completed_at = new Date().toISOString();
      log.push(obs);
      const terminal = result.outcome === 'pause_credential' ? 'pause_credential' : 'abort';
      return { run_id: runId, runbook: name, started_at: startedAt, terminal_state: terminal, reason: result.reason, observations: log, context };
    }

    if (typeof result.next_pointer === 'number' && result.next_pointer >= 0) {
      obs.completed_at = new Date().toISOString();
      log.push(obs);
      pointer = result.next_pointer;
      continue;
    }

    if (result.outcome === 'fail') {
      const onFailure = step.on_failure || 'abort';
      obs.on_failure_policy = onFailure;
      obs.completed_at = new Date().toISOString();
      log.push(obs);
      if (onFailure === 'ask') {
        return { run_id: runId, runbook: name, started_at: startedAt, terminal_state: 'pause_question', reason: `step ${stepIdx} failed -> ask: ${result.reason || JSON.stringify(result)}`, observations: log, context };
      }
      if (onFailure === 'retry') {
        // v1: don't loop, just record and continue
        pointer += 1;
        continue;
      }
      return { run_id: runId, runbook: name, started_at: startedAt, terminal_state: 'fail', reason: `step ${stepIdx} failed: ${result.reason || JSON.stringify(result)}`, observations: log, context };
    }

    obs.completed_at = new Date().toISOString();
    log.push(obs);
    pointer += 1;
  }

  return { run_id: runId, runbook: name, started_at: startedAt, terminal_state: 'complete', observations: log, context };
}

module.exports = { save, load, list, recordOutcome, run, _validateSteps, VALID_ACTIONS };
