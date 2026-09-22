// Shared assertions for the contract suite. promptfoo passes the MCP tool
// result as a JSON string of content blocks ([{type:'text', text:'...'}]), so
// every assertion unwraps blocks first, then parses OUR envelope from the text.

function text(output) {
  let v = output;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return v; }
  }
  if (Array.isArray(v)) return v.map((b) => b?.text ?? '').join('\n');
  if (v && typeof v === 'object' && typeof v.text === 'string') return v.text;
  return String(output);
}

function envelope(output) {
  try { return JSON.parse(text(output)); } catch { return null; }
}

const fail = (reason) => ({ pass: false, score: 0, reason });
const ok = (reason) => ({ pass: true, score: 1, reason });

/** {error, message, retriable, account} + non-empty hint: the 6.0.0 floor. */
function envelopeFloor(output, account) {
  const j = envelope(output);
  if (!j) return fail('not a parseable envelope: ' + text(output).slice(0, 160));
  for (const k of ['error', 'message', 'retriable', 'account']) {
    if (!(k in j)) return fail('missing ' + k);
  }
  if (typeof j.hint !== 'string' || j.hint.length === 0) return fail('hint floor violated for ' + j.error);
  if (j.account !== account) return fail('wrong account: ' + j.account);
  return ok(j.error);
}

export function gmailDiscoverCatalog(output) {
  const j = envelope(output);
  if (!j || !Array.isArray(j.operations) || j.operations.length === 0) return fail('no operations');
  if (!j.writeControl || !j.next) return fail('missing writeControl/next');
  return ok(`${j.operations.length} ops`);
}

export function gmailDiscoverFilter(output) {
  const j = envelope(output);
  const names = (j?.operations ?? []).map((o) => o.tool);
  if (!names.includes('gmail_send')) return fail('gmail_send missing from filtered catalog');
  // "send" legitimately matches ~21 ops (descriptions count); the contract is
  // that it narrows the ~80-op full catalog, not any specific count.
  if (names.length >= 40) return fail('filter did not narrow: ' + names.length);
  return ok(`${names.length} ops`);
}

export function gmailDiscoverNoMatch(output) {
  const j = envelope(output);
  if (!j || j.operations.length !== 0) return fail('expected empty operations');
  return /without query/i.test(j.next) ? ok(j.next) : fail(j.next);
}

export function discoverAllExpands(output) {
  const j = envelope(output);
  return j && typeof j.visibleTools === 'number' && j.visibleTools > 0
    ? ok('visible: ' + j.visibleTools)
    : fail(text(output).slice(0, 160));
}

export function discoverResetCollapses(output) {
  const j = envelope(output);
  return j && /callable by name/i.test(j.note) ? ok(j.note) : fail(text(output).slice(0, 160));
}

export function curatedToolResolves(output) {
  const s = text(output);
  if (/not found|unknown tool|no such tool/i.test(s)) return fail(s.slice(0, 200));
  return s.length > 0 ? ok(s.slice(0, 120)) : fail('empty output');
}

/** A schema rejection is an ENVELOPE like every other failure. It used to be
 * bare SDK prose with no slug, hint or retriable, which is the free-text
 * contract break the hint floor exists to prevent. */
export function validationVisible(output) {
  const s = text(output);
  let j;
  try { j = JSON.parse(s); } catch { return fail('not JSON: ' + s.slice(0, 160)); }
  if (j.error !== 'validation_error') return fail('slug: ' + String(j.error));
  if (!j.hint) return fail('no hint: ' + s.slice(0, 160));
  if (j.retriable !== false) return fail('retriable: ' + String(j.retriable));
  return ok(s.slice(0, 160));
}

/** A single unknown alias must name the VALID aliases. It used to leak the
 * CSV regex, implying a comma was required, and never named one. */
export function unknownAccountFailsValidation(output) {
  const s = text(output);
  let j;
  try { j = JSON.parse(s); } catch { return fail('not JSON: ' + s.slice(0, 160)); }
  if (j.error !== 'validation_error') return fail('slug: ' + String(j.error));
  if (!/account/i.test(s)) return fail('does not name the field: ' + s.slice(0, 160));
  if (!/Valid: /.test(s)) return fail('does not name the valid aliases: ' + s.slice(0, 160));
  if (/must match pattern|\^\[a-zA-Z0-9_-\]/.test(s)) return fail('leaks the CSV regex: ' + s.slice(0, 160));
  return ok(s.slice(0, 160));
}

export function coercesNotValidationError(output) {
  const s = text(output);
  if (/invalid arguments|-32602/i.test(s)) return fail('coercion failed: ' + s.slice(0, 160));
  return ok(s.slice(0, 120));
}

export function gmailEnvelopeFloor(output) { return envelopeFloor(output, 'example'); }
export function driveEnvelopeFloor(output) { return envelopeFloor(output, 'example'); }
export function calendarEnvelopeFloor(output) { return envelopeFloor(output, 'example'); }

export function searchUnknownApi(output) {
  const j = envelope(output);
  return j && j.error === 'unknown_api' && /known apis/i.test(j.hint ?? '')
    ? ok(j.hint.slice(0, 120))
    : fail(text(output).slice(0, 160));
}

export function callUnknownApi(output) {
  const j = envelope(output);
  return j && j.error === 'unknown_api' ? ok(j.hint?.slice(0, 120) ?? '') : fail(text(output).slice(0, 160));
}

export function callAmbiguousAlias(output) {
  const j = envelope(output);
  const ok_ = j && j.error === 'unknown_api' && j.hint?.includes('analyticsadmin') && j.hint?.includes('analyticsdata');
  return ok_ ? ok(j.hint.slice(0, 160)) : fail(text(output).slice(0, 160));
}

export function writeDisabled(output) {
  const j = envelope(output);
  const ok_ = j && j.error === 'write_disabled' && /GOOGLE_PROFILE/.test(j.hint ?? '') && /read-only/.test(j.message ?? '');
  return ok_ ? ok(j.message.slice(0, 160)) : fail(text(output).slice(0, 160));
}

// Wizard failures used to be bare prose, so these asserted on substrings.
// They are envelopes now: assert the slug and the recovery, not the wording.
export function accountAddEnvMode(output) {
  const j = envelope(output);
  if (!j) return fail('not a parseable envelope: ' + text(output).slice(0, 160));
  if (j.error !== 'E_ENV_ACCOUNTS_MODE') return fail('wrong slug: ' + j.error);
  if (j.retriable !== false) return fail('env mode is not retriable');
  if (!/migrate-config/.test(j.hint ?? '')) return fail('hint does not name the way out');
  return ok(j.error);
}

export function accountReauthUnknown(output) {
  const j = envelope(output);
  if (!j) return fail('not a parseable envelope: ' + text(output).slice(0, 160));
  // Same slug as an unknown alias passed to any other tool: one condition,
  // one name, wherever it is raised.
  if (j.error !== 'validation_error') return fail('wrong slug: ' + j.error);
  if (j.account !== 'nope') return fail('does not echo the rejected alias: ' + j.account);
  if (!(j.hint ?? '').includes('example')) return fail('hint does not list the known aliases');
  return ok(j.error);
}
