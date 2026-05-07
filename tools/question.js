// question.js - surface a Tate-question pause primitive from the agent.
//
// question.surface({ question, options?, fork_id?, deliver_via?, context?, expires_in_seconds? })
//   -> { id, surfaced_at, ... }
// question.poll({ id, timeout_ms?, interval_ms? })
//   -> { id, answered, answer, expired, ... } (blocks up to timeout_ms or returns first answered/expired state)
// question.get({ id }) -> single fetch (non-blocking)
//
// Backed by EcodiaOS /api/pending-questions/*. The agent never speaks
// directly to Tate; the backend handles chat injection via /api/os-session/message.
//
// Doctrine: ~/ecodiaos/patterns/macros-learn-by-doing-vision-first-run-with-question-surface.md
//
// Shipped 29 Apr 2026 (fork_mojsk7dl_c4424f).

const BACKEND_URL = process.env.ECODIAOS_BACKEND_URL || 'https://api.admin.ecodia.au';

async function _post(path, body) {
  const resp = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`POST ${path} -> ${resp.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { throw new Error(`POST ${path} returned non-JSON: ${text.slice(0, 200)}`); }
}

async function _get(path) {
  const resp = await fetch(`${BACKEND_URL}${path}`);
  const text = await resp.text();
  if (!resp.ok) throw new Error(`GET ${path} -> ${resp.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { throw new Error(`GET ${path} returned non-JSON: ${text.slice(0, 200)}`); }
}

async function surface(params) {
  const { question, options, fork_id, deliver_via, context, expires_in_seconds } = params || {};
  if (!question || typeof question !== 'string') {
    throw new Error('question.surface: question (string) required');
  }
  return _post('/api/pending-questions', { question, options, fork_id, deliver_via, context, expires_in_seconds });
}

async function get(params) {
  const { id } = params || {};
  if (!id) throw new Error('question.get: id required');
  return _get(`/api/pending-questions/${id}`);
}

async function poll(params) {
  const { id, timeout_ms, interval_ms } = params || {};
  if (!id) throw new Error('question.poll: id required');
  const deadline = Date.now() + Math.min(Math.max(1000, timeout_ms || 60_000), 300_000);
  const tick = Math.min(Math.max(500, interval_ms || 3000), 10_000);

  while (Date.now() < deadline) {
    const row = await _get(`/api/pending-questions/${id}`);
    if (row.answered || row.expired) return row;
    await new Promise(r => setTimeout(r, tick));
  }
  // Final fetch on timeout to return a fresh snapshot.
  return _get(`/api/pending-questions/${id}`);
}

module.exports = { surface, get, poll };
