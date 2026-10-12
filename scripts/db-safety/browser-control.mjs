// DIAGNOSTIC ONLY. This control experiment is not the browser-isolation safety
// rehearsal and can never count as passing it or as G5 closure evidence.
// It isolates hostname behaviour (127.0.0.1 vs localhost) from source-document
// state (neutral about:blank vs a Chrome error page) using the same connected
// browser, Fetch/Network configuration, broker policy and trace as the rehearsal.
// A Chrome cancellation is never treated as a broker denial: only an attributable
// Fetch.requestPaused followed by an explicit denial is INTERCEPTED_DENIED.
import assert from 'node:assert/strict';
import { allowedBrowserUrl, evaluateAmbientProbe } from './runtime-browser.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const IP_TARGET = 'http://127.0.0.1:9000/';
export const LOCALHOST_TARGET = 'http://localhost:9000/';
/** Existing, already-denied rehearsal target; used only to establish the Chrome error-page state. */
export const ERROR_STATE_ESTABLISHER = 'http://127.0.0.1:3000/';

/** Counterbalanced, two repeats per host and state. Each case establishes its own source state. */
export const CONTROL_CASES = Object.freeze([
  { id: 'N1', source: 'neutral', host: 'ip', target: IP_TARGET },
  { id: 'N2', source: 'neutral', host: 'localhost', target: LOCALHOST_TARGET },
  { id: 'N3', source: 'neutral', host: 'localhost', target: LOCALHOST_TARGET },
  { id: 'N4', source: 'neutral', host: 'ip', target: IP_TARGET },
  { id: 'E1', source: 'error-page', host: 'ip', target: IP_TARGET },
  { id: 'E2', source: 'error-page', host: 'localhost', target: LOCALHOST_TARGET },
  { id: 'E3', source: 'error-page', host: 'localhost', target: LOCALHOST_TARGET },
  { id: 'E4', source: 'error-page', host: 'ip', target: IP_TARGET },
].map(item => Object.freeze(item)));

const isNeutral = state => state?.frame?.url === 'about:blank' && !state.frame.unreachableUrl;
const isErrorPageFor = url => state => typeof state?.frame?.url === 'string' && state.frame.url.startsWith('chrome-error://') && state.frame.unreachableUrl === new URL(url).href;

async function navigateRaw(browser, url) {
  try {
    const result = await browser.send('Page.navigate', { url });
    return { url, frameId: result?.frameId ?? null, loaderIdPresent: Boolean(result?.loaderId), errorText: result?.errorText ?? null, threw: null };
  } catch (error) {
    return { url, frameId: null, loaderIdPresent: false, errorText: null, threw: /^[A-Z][A-Z0-9_]+$/.test(error?.message) ? error.message : 'BROWSER_NAVIGATE_FAILED' };
  }
}

/** Polls (bounded) until the frame matches the expected state and no loading is active. Control-only; never used by the rehearsal. */
async function settle(browser, expected, { maxMs = 8000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + maxMs;
  let state = null, polls = 0;
  do {
    state = await browser.captureNavigationState();
    polls += 1;
    if (expected(state) && state.eventDerived.loading === false) return { ok: true, polls, state };
    await delay(intervalMs);
  } while (Date.now() < deadline);
  return { ok: false, polls, state };
}

async function establishSource(browser, source) {
  const steps = [];
  steps.push(await navigateRaw(browser, 'about:blank'));
  let result = await settle(browser, isNeutral);
  if (result.ok && source === 'error-page') {
    steps.push(await navigateRaw(browser, ERROR_STATE_ESTABLISHER));
    result = await settle(browser, isErrorPageFor(ERROR_STATE_ESTABLISHER));
  }
  return { source, established: result.ok, polls: result.polls, steps, state: result.state };
}

/** Diagnostic outcome label. Cancellation and navigation errors are never promoted to a denial. */
export function outcomeFor(evaluation, correlation) {
  if (evaluation.verdict === 'ALLOWED') return 'ALLOWED_SAFETY_FAILURE';
  if (evaluation.verdict === 'UNATTRIBUTED') return 'UNATTRIBUTED_DENIAL';
  if (evaluation.verdict === 'DENIED_OBSERVED') return 'INTERCEPTED_DENIED';
  const events = correlation?.events ?? [];
  const sent = events.some(entry => entry.method === 'Network.requestWillBeSent');
  const failed = events.find(entry => entry.method === 'Network.loadingFailed');
  if (sent && failed?.canceled === true) return 'CANCELED_BEFORE_PAUSE';
  if (sent) return 'REQUEST_SENT_NOT_PAUSED';
  return 'NO_REQUEST_EVIDENCE';
}

/** Pure: H1 hostname-specific, H2 source-state-specific, H3 interaction/other. Invalid or inconsistent cases never support H1/H2. */
export function classifyControl(cases) {
  const group = (source, host) => cases.filter(item => item.valid && item.source === source && item.host === host).map(item => item.outcome);
  const uniform = outcomes => (outcomes.length >= 2 && outcomes.every(outcome => outcome === outcomes[0]) ? outcomes[0] : outcomes.length ? 'INCONSISTENT' : 'NO_VALID_CASES');
  const summary = { neutralIp: uniform(group('neutral', 'ip')), neutralLocalhost: uniform(group('neutral', 'localhost')), errorPageIp: uniform(group('error-page', 'ip')), errorPageLocalhost: uniform(group('error-page', 'localhost')) };
  const intercepted = 'INTERCEPTED_DENIED', canceled = 'CANCELED_BEFORE_PAUSE';
  let hypothesis = 'H3', reason = 'neither variable independently explains the result';
  if (summary.neutralIp === intercepted && summary.neutralLocalhost === canceled) {
    hypothesis = 'H1'; reason = 'from the neutral state 127.0.0.1:9000 is intercepted while localhost:9000 is canceled before any Fetch pause';
  } else if (summary.neutralIp === intercepted && summary.neutralLocalhost === intercepted
    && [summary.errorPageIp, summary.errorPageLocalhost].some(outcome => outcome !== intercepted && !['INCONSISTENT', 'NO_VALID_CASES'].includes(outcome))) {
    hypothesis = 'H2'; reason = 'both host forms are intercepted from the neutral state, but behavior changes from the error-page state';
  }
  return { hypothesis, reason, summary };
}

/**
 * Runs the eight independent control cases. Throws (safety failure) the moment
 * any ambient request is allowed; otherwise returns diagnostics only.
 */
export async function runBrowserControlExperiment(browser, runtime, environment) {
  assert.ok(browser.trace && typeof browser.captureNavigationState === 'function', 'control experiment requires the traced browser');
  const cases = [];
  for (const spec of CONTROL_CASES) {
    assert.throws(() => allowedBrowserUrl(runtime, environment, spec.target), error => error.message === 'BROWSER_RESOURCE_TARGET_DENIED');
    const establishment = await establishSource(browser, spec.source);
    const sourceMatches = spec.source === 'neutral' ? isNeutral(establishment.state) : isErrorPageFor(ERROR_STATE_ESTABLISHER)(establishment.state);
    const valid = establishment.established && sourceMatches && establishment.state.eventDerived.loading === false;
    const record = { id: spec.id, source: spec.source, host: spec.host, target: spec.target, valid, establishment: { established: establishment.established, polls: establishment.polls, steps: establishment.steps, sourceState: establishment.state } };
    if (!valid) { record.outcome = 'SOURCE_STATE_NOT_ESTABLISHED'; cases.push(record); continue; }
    const startSeq = browser.trace.state().nextSeq;
    const mark = browser.trace.mark('control-start', { case: spec.id, url: spec.target, source: spec.source, host: spec.host });
    const start = browser.requests.length;
    record.navigate = await navigateRaw(browser, spec.target);
    // Same observation rule and timeout as the rehearsal: 100 x 20 ms for an attributable intercepted request.
    for (let attempt = 0; attempt < 100 && !evaluateAmbientProbe(browser.requests, start, spec.target).own.length; attempt++) await delay(20);
    const evaluation = evaluateAmbientProbe(browser.requests, start, spec.target);
    const end = browser.trace.mark('control-end', { case: spec.id, url: spec.target, verdict: evaluation.verdict });
    const correlation = browser.trace.correlate(spec.target);
    // Only this case's requests: correlate() spans the whole trace, so keep entries inside the case window.
    const inWindow = correlation.events.filter(entry => entry.seq >= startSeq && entry.seq <= end.seq);
    record.outcome = outcomeFor(evaluation, { events: inWindow });
    record.verdict = evaluation.verdict;
    record.intercepted = [...evaluation.own, ...evaluation.foreign, ...evaluation.unattributed].map(({ allowed, error, url, resourceType, frameId }) => ({ allowed, error: error ?? null, url: url ?? null, resourceType: resourceType ?? null, frameId: frameId ?? null }));
    record.window = { startSeq, controlStartSeq: mark.seq, endSeq: end.seq };
    record.correlated = inWindow;
    record.orderedEvents = browser.trace.slice(startSeq, end.seq);
    if (record.outcome === 'ALLOWED_SAFETY_FAILURE') {
      cases.push(record);
      const error = Error('BROWSER_CONTROL_AMBIENT_REQUEST_ALLOWED');
      error.browserControlCases = cases;
      throw error;
    }
    // Final state after the lifecycle has settled (bounded), so the end document/error page is on record.
    const final = await settle(browser, () => true);
    record.finalState = final.state;
    cases.push(record);
    if (browser.brokerErrors.length) {
      const error = Error('BROWSER_CONTROL_BROKER_ERROR');
      error.browserControlCases = cases;
      throw error;
    }
  }
  const classification = classifyControl(cases);
  return {
    diagnosticOnly: true,
    countsAsRehearsalPass: false,
    countsAsG5Evidence: false,
    design: { cases: CONTROL_CASES, neutralState: 'about:blank, empty unreachableUrl, not loading (frame tree + event-derived)', errorPageState: `chrome-error:// document with unreachableUrl ${ERROR_STATE_ESTABLISHER}, not loading`, observation: '100 x 20 ms per navigation, identical to the rehearsal; no retry, no gate' },
    cases,
    classification,
  };
}
