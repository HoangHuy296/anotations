import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBrowserTrace } from '../browser-trace.mjs';
import { denyPausedRequest } from '../runtime-browser.mjs';
import { CONTROL_CASES, ERROR_STATE_ESTABLISHER, IP_TARGET, LOCALHOST_TARGET, classifyControl, outcomeFor, runBrowserControlExperiment } from '../browser-control.mjs';

// Fake CDP only: no browser, container, network or database.
const runtime = { roles: { web: { port: 55463 } } };
const environment = { MINIO_ENDPOINT: 'http://127.0.0.1:55462' };
const clock = () => { let t = 0; return () => (t += 0.5); };

/** Models a browser. `behavior(url, state)` returns 'denied' | 'canceled' | 'allowed' | 'nothing' for a navigation to url. */
function fakeBrowser(behavior) {
  const trace = createBrowserTrace({ now: clock() });
  const requests = [], navigations = [];
  const doc = { url: 'about:blank', unreachableUrl: null };
  let n = 0;
  const browser = {
    trace, requests, brokerErrors: [], navigations, doc,
    captureNavigationState: async () => ({ eventDerived: trace.state(), frame: { url: doc.url, unreachableUrl: doc.unreachableUrl }, history: { entryCount: 1 }, errors: [] }),
    send: async (method, params) => {
      assert.equal(method, 'Page.navigate');
      trace.recordCommand(method, params);
      navigations.push(params.url);
      const url = params.url;
      let result;
      if (url === 'about:blank') {
        trace.recordEvent('Page.frameStartedLoading', { frameId: 'F' });
        doc.url = 'about:blank'; doc.unreachableUrl = null;
        trace.recordEvent('Page.frameNavigated', { frame: { id: 'F', url: 'about:blank' }, type: 'Navigation' });
        trace.recordEvent('Page.frameStoppedLoading', { frameId: 'F' });
        result = { frameId: 'F', loaderId: 'L' };
      } else {
        const mode = behavior(url, { source: doc.url.startsWith('chrome-error') ? 'error-page' : 'neutral' });
        n += 1;
        trace.recordEvent('Page.frameStartedNavigating', { frameId: 'F', url, loaderId: `L${n}`, navigationType: 'differentDocument' });
        trace.recordEvent('Page.frameStartedLoading', { frameId: 'F' });
        trace.recordEvent('Network.requestWillBeSent', { requestId: `N${n}`, loaderId: `L${n}`, frameId: 'F', type: 'Document', request: { url, method: 'GET' } });
        if (mode === 'denied') {
          trace.recordEvent('Fetch.requestPaused', { requestId: `I${n}`, networkId: `N${n}`, frameId: 'F', resourceType: 'Document', request: { url, method: 'GET' } });
          await denyPausedRequest(requests, { requestId: `I${n}`, request: { url }, resourceType: 'Document', frameId: 'F' }, async (m, p) => { trace.recordCommand(m, p); trace.recordResult(m, p, {}); return {}; }, 'S', u => trace.probeFor(u));
          trace.recordEvent('Network.loadingFailed', { requestId: `N${n}`, errorText: 'net::ERR_BLOCKED_BY_CLIENT', canceled: false, blockedReason: 'inspector' });
          doc.url = 'chrome-error://chromewebdata/'; doc.unreachableUrl = new URL(url).href;
          result = { frameId: 'F', loaderId: `L${n}`, errorText: 'net::ERR_BLOCKED_BY_CLIENT' };
        } else if (mode === 'canceled') {
          trace.recordEvent('Network.loadingFailed', { requestId: `N${n}`, errorText: 'net::ERR_ABORTED', canceled: true });
          result = { frameId: 'F', loaderId: `L${n}`, errorText: 'net::ERR_ABORTED' };
        } else if (mode === 'allowed') {
          requests.push({ allowed: true, url: new URL(url).href, origin: new URL(url).origin, status: 200 });
          result = { frameId: 'F', loaderId: `L${n}` };
        } else { result = { frameId: 'F', loaderId: `L${n}` }; }
        trace.recordEvent('Page.frameStoppedLoading', { frameId: 'F' });
      }
      trace.recordResult(method, params, result);
      return result;
    },
  };
  return browser;
}
const outcomes = result => Object.fromEntries(result.cases.map(item => [item.id, item.outcome]));

test('design: eight independent cases, two repeats per host and source, counterbalanced, port 9000, never the real probe set', () => {
  assert.deepEqual(CONTROL_CASES.map(item => `${item.id}:${item.source}:${item.host}`), ['N1:neutral:ip', 'N2:neutral:localhost', 'N3:neutral:localhost', 'N4:neutral:ip', 'E1:error-page:ip', 'E2:error-page:localhost', 'E3:error-page:localhost', 'E4:error-page:ip']);
  assert.ok(CONTROL_CASES.every(item => [IP_TARGET, LOCALHOST_TARGET].includes(item.target)));
  assert.equal(IP_TARGET, 'http://127.0.0.1:9000/'); assert.equal(LOCALHOST_TARGET, 'http://localhost:9000/');
  assert.equal(ERROR_STATE_ESTABLISHER, 'http://127.0.0.1:3000/');
  assert.throws(() => { CONTROL_CASES[0].target = 'x'; }); // frozen
});

test('every case establishes its own source state and no case starts from another case\'s result', async () => {
  const browser = fakeBrowser(url => 'denied');
  const result = await runBrowserControlExperiment(browser, runtime, environment);
  assert.equal(result.cases.length, 8);
  // Each neutral case is preceded by about:blank; each error-page case by about:blank then the established error page.
  const expected = [];
  for (const spec of CONTROL_CASES) { expected.push('about:blank'); if (spec.source === 'error-page') expected.push(ERROR_STATE_ESTABLISHER); expected.push(spec.target); }
  assert.deepEqual(browser.navigations, expected);
  for (const item of result.cases) {
    assert.equal(item.valid, true);
    const source = item.establishment.sourceState;
    if (item.source === 'neutral') { assert.equal(source.frame.url, 'about:blank'); assert.equal(source.frame.unreachableUrl, null); }
    else { assert.ok(source.frame.url.startsWith('chrome-error://')); assert.equal(source.frame.unreachableUrl, ERROR_STATE_ESTABLISHER); }
    assert.equal(source.eventDerived.loading, false);
  }
});

test('each case records ordered evidence: pre-state, lifecycle, request, pause, broker decision, ack, requestId-correlated loadingFailed, navigate result, final state', async () => {
  const result = await runBrowserControlExperiment(fakeBrowser(() => 'denied'), runtime, environment);
  const item = result.cases[4]; // E1
  assert.equal(item.outcome, 'INTERCEPTED_DENIED');
  const methods = item.orderedEvents.map(entry => `${entry.kind}:${entry.method}`);
  for (const wanted of ['mark:control-start', 'command:Page.navigate', 'event:Page.frameStartedNavigating', 'event:Network.requestWillBeSent', 'event:Fetch.requestPaused', 'command:Fetch.failRequest', 'command-result:Fetch.failRequest', 'event:Network.loadingFailed', 'command-result:Page.navigate', 'mark:control-end']) assert.ok(methods.includes(wanted), wanted);
  assert.ok(methods.indexOf('event:Fetch.requestPaused') < methods.indexOf('command:Fetch.failRequest'));
  assert.deepEqual(item.orderedEvents.map(entry => entry.seq), [...item.orderedEvents.map(entry => entry.seq)].sort((a, b) => a - b));
  assert.equal(item.intercepted[0].allowed, false);
  assert.ok(item.correlated.some(entry => entry.method === 'Network.loadingFailed' && entry.errorText === 'net::ERR_BLOCKED_BY_CLIENT'));
  assert.equal(item.navigate.errorText, 'net::ERR_BLOCKED_BY_CLIENT');
  assert.ok(item.finalState && item.finalState.frame);
  assert.ok(item.establishment.sourceState.frame.url.startsWith('chrome-error://'));
});

test('a Chrome cancellation is never a denial: it is labelled CANCELED_BEFORE_PAUSE with the correlated loadingFailed as evidence only', async () => {
  const result = await runBrowserControlExperiment(fakeBrowser(url => (url.includes('localhost') ? 'canceled' : 'denied')), runtime, environment);
  const canceled = result.cases.find(item => item.id === 'N2');
  assert.equal(canceled.outcome, 'CANCELED_BEFORE_PAUSE'); assert.equal(canceled.verdict, 'NOT_OBSERVED');
  assert.deepEqual(canceled.intercepted, []);
  assert.deepEqual(canceled.correlated.filter(entry => entry.method.startsWith('Network.')).map(entry => entry.method), ['Network.requestWillBeSent', 'Network.loadingFailed']);
  assert.equal(canceled.correlated.some(entry => entry.method === 'Fetch.requestPaused'), false);
  assert.equal(canceled.navigate.errorText, 'net::ERR_ABORTED');
  assert.equal(result.cases.find(item => item.id === 'N1').outcome, 'INTERCEPTED_DENIED');
});

test('the experiment is diagnostic only: it can never count as the rehearsal pass or as G5 evidence', async () => {
  const result = await runBrowserControlExperiment(fakeBrowser(() => 'denied'), runtime, environment);
  assert.equal(result.diagnosticOnly, true); assert.equal(result.countsAsRehearsalPass, false); assert.equal(result.countsAsG5Evidence, false);
  assert.equal('pass' in result, false);
  assert.equal(result.cases.some(item => 'pass' in item), false);
});

test('an allowed ambient request is a safety failure that stops the experiment immediately', async () => {
  const browser = fakeBrowser((url, state) => (url === LOCALHOST_TARGET ? 'allowed' : 'denied'));
  let caught;
  await runBrowserControlExperiment(browser, runtime, environment).catch(error => { caught = error; });
  assert.equal(caught?.message, 'BROWSER_CONTROL_AMBIENT_REQUEST_ALLOWED');
  assert.equal(caught.browserControlCases.at(-1).outcome, 'ALLOWED_SAFETY_FAILURE');
  assert.equal(caught.browserControlCases.length, 2); // N1, then N2 stopped the run
});

test('a case whose source state cannot be established is recorded invalid and never counted', async () => {
  const browser = fakeBrowser(() => 'denied');
  const original = browser.captureNavigationState;
  browser.captureNavigationState = async () => { const state = await original(); return { ...state, frame: { url: 'https://unexpected.example/', unreachableUrl: null } }; };
  const real = Date.now; let t = 0; Date.now = () => (t += 4000);
  try { const result = await runBrowserControlExperiment(browser, runtime, environment); assert.ok(result.cases.every(item => item.valid === false && item.outcome === 'SOURCE_STATE_NOT_ESTABLISHED')); assert.equal(result.classification.hypothesis, 'H3'); }
  finally { Date.now = real; }
});

test('classification: H1 hostname-specific', async () => {
  const result = await runBrowserControlExperiment(fakeBrowser(url => (url.includes('localhost') ? 'canceled' : 'denied')), runtime, environment);
  assert.equal(result.classification.hypothesis, 'H1');
  assert.deepEqual(result.classification.summary, { neutralIp: 'INTERCEPTED_DENIED', neutralLocalhost: 'CANCELED_BEFORE_PAUSE', errorPageIp: 'INTERCEPTED_DENIED', errorPageLocalhost: 'CANCELED_BEFORE_PAUSE' });
});
test('classification: H2 source-state-specific', async () => {
  const result = await runBrowserControlExperiment(fakeBrowser((url, state) => (state.source === 'error-page' && url.includes('localhost') ? 'canceled' : 'denied')), runtime, environment);
  assert.equal(result.classification.hypothesis, 'H2');
  assert.equal(result.classification.summary.neutralLocalhost, 'INTERCEPTED_DENIED'); assert.equal(result.classification.summary.errorPageLocalhost, 'CANCELED_BEFORE_PAUSE');
});
test('classification: H3 for interaction/other and for inconsistent repeats', async () => {
  const both = await runBrowserControlExperiment(fakeBrowser(() => 'canceled'), runtime, environment);
  assert.equal(both.classification.hypothesis, 'H3');
  let flip = 0;
  const flaky = await runBrowserControlExperiment(fakeBrowser(url => (url.includes('localhost') && (flip++ % 2) ? 'canceled' : 'denied')), runtime, environment);
  assert.equal(flaky.classification.hypothesis, 'H3');
  assert.ok(Object.values(flaky.classification.summary).includes('INCONSISTENT'));
  // Pure function: invalid cases cannot support H1.
  assert.equal(classifyControl([{ valid: false, source: 'neutral', host: 'ip', outcome: 'INTERCEPTED_DENIED' }, { valid: false, source: 'neutral', host: 'localhost', outcome: 'CANCELED_BEFORE_PAUSE' }]).hypothesis, 'H3');
});

test('outcome labelling never promotes cancellation, absence or navigation errors to a denial', () => {
  const none = { verdict: 'NOT_OBSERVED' };
  assert.equal(outcomeFor(none, { events: [] }), 'NO_REQUEST_EVIDENCE');
  assert.equal(outcomeFor(none, { events: [{ method: 'Network.requestWillBeSent' }] }), 'REQUEST_SENT_NOT_PAUSED');
  assert.equal(outcomeFor(none, { events: [{ method: 'Network.requestWillBeSent' }, { method: 'Network.loadingFailed', canceled: true }] }), 'CANCELED_BEFORE_PAUSE');
  assert.equal(outcomeFor({ verdict: 'DENIED_OBSERVED' }, { events: [] }), 'INTERCEPTED_DENIED');
  assert.equal(outcomeFor({ verdict: 'ALLOWED' }, { events: [] }), 'ALLOWED_SAFETY_FAILURE');
});

test('the real rehearsal and isolation are untouched and the diagnostic scope is exact', () => {
  const browserSource = readFileSync(new URL('../runtime-browser.mjs', import.meta.url), 'utf8');
  assert.match(browserSource, /const probes = \['http:\/\/127\.0\.0\.1:3000\/', 'http:\/\/localhost:9000\/', 'http:\/\/127\.0\.0\.1:5433\/'\];/);
  assert.match(browserSource, /attempt < 100 && !evaluateAmbientProbe\(browser\.requests, start, url\)\.own\.length; attempt\+\+\) await delay\(20\)/);
  assert.match(browserSource, /'--network', 'none'/);
  const control = readFileSync(new URL('../browser-control.mjs', import.meta.url), 'utf8');
  assert.equal(/retry|retries/i.test(control.replace(/no retry/g, '')), false);
  const suite = readFileSync(new URL('../runtime-suite.mjs', import.meta.url), 'utf8');
  assert.match(suite, /const controlOnly = checked\.r\.command === 'g5:runtime:browser-control';/);
  assert.match(suite, /if\(controlOnly\) \{\s*evidence\.scenarios\.push\(\{name:'g5-browser-control-diagnostic-executed',diagnosticOnly:true,countsAsRehearsalPass:false\}\);/);
  const commands = JSON.parse(readFileSync(new URL('../commands.json', import.meta.url), 'utf8'));
  assert.deepEqual(commands['g5:runtime:browser-control'], commands['g5:runtime:e2e']);
  assert.match(readFileSync(new URL('../g3-rehearse.py', import.meta.url), 'utf8'), /'g5VerificationExecuted':G5 and not DIAGNOSTIC/);
});
