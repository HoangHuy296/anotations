import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBrowserTrace, summarizeFrameTree, summarizeHistory, TRACED_COMMAND_METHODS, TRACED_EVENT_METHODS } from '../browser-trace.mjs';
import { denyPausedRequest, describeDeniedRequest, evaluateAmbientProbe, rehearseBrowserIsolation } from '../runtime-browser.mjs';

// Fake CDP only: no browser, container, network or database.
const A = 'http://127.0.0.1:3000/', B = 'http://localhost:9000/', C = 'http://127.0.0.1:5433/';
const runtime = { roles: { web: { port: 55463 } } };
const environment = { MINIO_ENDPOINT: 'http://127.0.0.1:55462' };
const will = (requestId, url, extra = {}) => ({ requestId, loaderId: `L-${requestId}`, frameId: 'F', type: 'Document', request: { url, method: 'GET', headers: { cookie: 'SECRET', authorization: 'Bearer SECRET' } }, documentURL: url, initiator: { type: 'other' }, timestamp: 1, ...extra });
const paused = (requestId, networkId, url) => ({ requestId, networkId, frameId: 'F', resourceType: 'Document', request: { url, method: 'GET', headers: { cookie: 'SECRET' }, postData: 'SECRET' } });
const clock = () => { let t = 0; return () => (t += 1.5); };

test('only whitelisted events are recorded, with whitelisted fields and no headers, cookies or post data', () => {
  const trace = createBrowserTrace({ now: clock() });
  assert.equal(trace.recordEvent('Network.dataReceived', { requestId: '1' }), null);
  trace.recordEvent('Network.requestWillBeSent', will('1', A));
  trace.recordEvent('Fetch.requestPaused', paused('i1', '1', A));
  const text = JSON.stringify(trace.entries);
  assert.equal(text.includes('SECRET'), false);
  assert.deepEqual(Object.keys(trace.entries[0]).sort(), ['cdpTimestamp', 'documentURL', 'frameId', 'initiatorType', 'httpMethod', 'kind', 'loaderId', 'method', 'redirect', 'requestId', 'resourceType', 'seq', 'tMs', 'url'].sort());
  for (const method of ['Fetch.requestPaused', 'Network.requestWillBeSent', 'Network.loadingFailed', 'Network.loadingFinished', 'Page.frameRequestedNavigation', 'Page.frameStartedNavigating', 'Page.frameNavigated', 'Page.frameStoppedLoading']) assert.ok(TRACED_EVENT_METHODS.includes(method), method);
  for (const method of ['Page.navigate', 'Fetch.failRequest', 'Page.getFrameTree', 'Page.getNavigationHistory']) assert.ok(TRACED_COMMAND_METHODS.includes(method), method);
});

test('entries carry strictly increasing sequence numbers and non-decreasing monotonic timestamps', () => {
  const trace = createBrowserTrace({ now: clock() });
  trace.recordEvent('Page.frameStartedLoading', { frameId: 'F' });
  trace.mark('probe-start', { probe: 0, url: A });
  trace.recordCommand('Page.navigate', { url: A });
  trace.recordResult('Page.navigate', { url: A }, { frameId: 'F', loaderId: 'L', errorText: 'net::ERR_ABORTED' });
  const seqs = trace.entries.map(entry => entry.seq), times = trace.entries.map(entry => entry.tMs);
  assert.deepEqual(seqs, [1, 2, 3, 4]);
  assert.ok(times.every((time, index) => index === 0 || time >= times[index - 1]));
  assert.deepEqual(trace.slice(2, 3).map(entry => entry.method), ['probe-start', 'Page.navigate']);
});

test('loadingFailed and loadingFinished (no URL) are correlated by requestId, never by URL', () => {
  const trace = createBrowserTrace({ now: clock() });
  trace.recordEvent('Network.requestWillBeSent', will('REQ-A', A));
  trace.recordEvent('Network.requestWillBeSent', will('REQ-B', B));
  trace.recordEvent('Network.loadingFailed', { requestId: 'REQ-B', type: 'Document', errorText: 'net::ERR_ABORTED', canceled: true, timestamp: 2 });
  trace.recordEvent('Network.loadingFinished', { requestId: 'REQ-A', encodedDataLength: 0, timestamp: 2 });
  const forB = trace.correlate(B);
  assert.deepEqual(forB.networkRequestIds, ['REQ-B']);
  assert.deepEqual(forB.events.map(entry => entry.method), ['Network.requestWillBeSent', 'Network.loadingFailed']);
  assert.equal(forB.events[1].url, undefined);
  assert.equal(forB.events[1].errorText, 'net::ERR_ABORTED');
  assert.deepEqual(trace.correlate(A).events.map(entry => entry.method), ['Network.requestWillBeSent', 'Network.loadingFinished']);
  assert.deepEqual(trace.correlate(C).events, []);
});

test('Fetch.requestPaused joins to its Network request through networkId and to its failRequest ack through the Fetch requestId', () => {
  const trace = createBrowserTrace({ now: clock() });
  trace.recordEvent('Network.requestWillBeSent', will('N1', A));
  trace.recordEvent('Fetch.requestPaused', paused('I1', 'N1', A));
  trace.recordCommand('Fetch.failRequest', { requestId: 'I1', errorReason: 'BlockedByClient' });
  trace.recordResult('Fetch.failRequest', { requestId: 'I1', errorReason: 'BlockedByClient' }, {});
  trace.recordEvent('Network.loadingFailed', { requestId: 'N1', errorText: 'net::ERR_BLOCKED_BY_CLIENT', canceled: false, blockedReason: 'inspector' });
  trace.recordCommand('Fetch.failRequest', { requestId: 'OTHER', errorReason: 'BlockedByClient' });
  const events = trace.correlate(A).events;
  assert.deepEqual(events.map(entry => `${entry.kind}:${entry.method}`), ['event:Network.requestWillBeSent', 'event:Fetch.requestPaused', 'command:Fetch.failRequest', 'command-result:Fetch.failRequest', 'event:Network.loadingFailed']);
  assert.equal(events[3].acknowledged, true);
});

test('event-derived navigation state tracks loading, last navigation event and an error-page commit without any CDP command', () => {
  const trace = createBrowserTrace({ now: clock() });
  assert.deepEqual({ loading: trace.state().loading }, { loading: false });
  trace.recordEvent('Page.frameStartedLoading', { frameId: 'F' });
  trace.recordEvent('Page.frameRequestedNavigation', { frameId: 'F', url: A, reason: 'typeInput', disposition: 'currentTab' });
  assert.equal(trace.state().loading, true);
  assert.equal(trace.state().lastNavigationEvent.url, A);
  trace.recordEvent('Page.frameNavigated', { frame: { id: 'F', loaderId: 'L2', url: 'chrome-error://chromewebdata/', unreachableUrl: A, mimeType: 'text/html' }, type: 'Navigation' });
  assert.equal(trace.state().lastFrameNavigated.unreachableUrl, A);
  assert.equal(trace.state().loading, true);
  trace.recordEvent('Page.frameStoppedLoading', { frameId: 'F' });
  assert.equal(trace.state().loading, false);
  assert.equal(trace.state().nextSeq, trace.entries.length + 1);
});

test('frame-tree and history summaries keep identity fields only', () => {
  assert.deepEqual(summarizeFrameTree({ frameTree: { frame: { id: 'F', loaderId: 'L', url: 'chrome-error://chromewebdata/', unreachableUrl: A, secret: 'x' } } }), { frameId: 'F', loaderId: 'L', url: 'chrome-error://chromewebdata/', unreachableUrl: A, mimeType: null });
  assert.deepEqual(summarizeHistory({ currentIndex: 1, entries: [{ id: 1, url: 'about:blank', transitionType: 'typed' }, { id: 2, url: A, title: 'x', transitionType: 'typed' }] }), { currentIndex: 1, entryCount: 2, current: { id: 2, url: A, transitionType: 'typed' } });
  assert.equal(summarizeFrameTree({}), null);
});

test('the trace is bounded and reports truncation', () => {
  const trace = createBrowserTrace({ now: clock(), limit: 3 });
  for (let i = 0; i < 5; i++) trace.recordEvent('Page.frameStoppedLoading', { frameId: 'F' });
  assert.equal(trace.snapshot().count, 3); assert.equal(trace.snapshot().truncated, true);
});

test('probe identity comes from the URL registered at probe start, not from window position', () => {
  const trace = createBrowserTrace({ now: clock() });
  trace.mark('probe-start', { probe: 0, url: A });
  trace.mark('probe-start', { probe: 1, url: B });
  assert.equal(trace.probeFor(A), 0); assert.equal(trace.probeFor(B), 1); assert.equal(trace.probeFor(C), null); assert.equal(trace.probeFor('nope'), null);
  // A denial for probe 0's URL that is processed late, while probe 1 is active, is still attributed to probe 0.
  const late = describeDeniedRequest({ requestId: 'x', request: { url: A }, resourceType: 'Document', frameId: 'F' }, url => trace.probeFor(url));
  assert.equal(late.probe, 0);
  assert.equal(evaluateAmbientProbe([late], 0, B).verdict, 'NOT_OBSERVED');
  assert.equal(describeDeniedRequest({ request: {} }, url => trace.probeFor(url)).probe, null);
});

test('denyPausedRequest records the denial, attributes the probe and sends failRequest(BlockedByClient)', async () => {
  const trace = createBrowserTrace({ now: clock() });
  trace.mark('probe-start', { probe: 1, url: B });
  const requests = [], sent = [];
  await denyPausedRequest(requests, { requestId: 'I9', request: { url: B }, resourceType: 'Document', frameId: 'F' }, async (method, params, session) => { sent.push({ method, params, session }); return {}; }, 'S', url => trace.probeFor(url));
  assert.equal(requests[0].allowed, false); assert.equal(requests[0].probe, 1); assert.equal(requests[0].url, B);
  assert.deepEqual(sent, [{ method: 'Fetch.failRequest', params: { requestId: 'I9', errorReason: 'BlockedByClient' }, session: 'S' }]);
});

// --- rehearsal with a traced fake browser ---------------------------------
function tracedBrowser(onNavigate) {
  const trace = createBrowserTrace({ now: clock() });
  const requests = [], navigations = [], states = [];
  const browser = {
    trace, requests, brokerErrors: [], navigations, states,
    captureNavigationState: async () => { const state = { eventDerived: trace.state(), frame: { url: 'about:blank' }, history: { entryCount: 1 }, errors: [] }; states.push(trace.state().nextSeq); return state; },
    send: async (method, params) => {
      assert.equal(method, 'Page.navigate'); navigations.push(params.url);
      trace.recordCommand(method, params);
      const result = await onNavigate(params.url, { trace, requests, count: navigations.length });
      trace.recordResult(method, params, result);
      return result;
    },
  };
  return browser;
}
const failure = async browser => { let caught; await rehearseBrowserIsolation(browser, runtime, environment).catch(error => { caught = error; }); assert.ok(caught); return caught; };
const denyOwn = async (url, { trace, requests }, n) => {
  trace.recordEvent('Network.requestWillBeSent', will(`N${n}`, url));
  trace.recordEvent('Fetch.requestPaused', paused(`I${n}`, `N${n}`, url));
  await denyPausedRequest(requests, { requestId: `I${n}`, request: { url }, resourceType: 'Document', frameId: 'F' }, async (method, params) => { trace.recordCommand(method, params); trace.recordResult(method, params, {}); return {}; }, 'S', u => trace.probeFor(u));
};

test('pre-probe state is captured before each navigation and the ordered window is reported per probe', async () => {
  const browser = tracedBrowser(async (url, ctx) => { await denyOwn(url, ctx, ctx.count); return { frameId: 'F', loaderId: 'L', errorText: 'net::ERR_BLOCKED_BY_CLIENT' }; });
  const results = await rehearseBrowserIsolation(browser, runtime, environment);
  assert.deepEqual(browser.navigations, [A, B, C]);
  results.forEach((result, index) => {
    assert.equal(result.pass, true); assert.equal(result.probe, index);
    assert.ok(result.preState && result.preState.eventDerived && 'loading' in result.preState.eventDerived);
    assert.ok(result.window.endSeq > result.window.startSeq);
    const methods = result.orderedEvents.map(entry => `${entry.kind}:${entry.method}`);
    assert.ok(methods.indexOf('mark:probe-start') < methods.indexOf('command:Page.navigate'), 'state capture precedes navigation; probe-start precedes navigate');
    assert.ok(methods.includes('event:Fetch.requestPaused') && methods.includes('command-result:Fetch.failRequest'));
    assert.deepEqual(result.orderedEvents.map(entry => entry.seq), [...result.orderedEvents.map(entry => entry.seq)].sort((a, b) => a - b));
    assert.equal(result.intercepted[0].probe, index);
  });
});

test('ERR_ABORTED with requestWillBeSent and loadingFailed but no Fetch.requestPaused still fails and exposes the ordered evidence', async () => {
  const browser = tracedBrowser(async (url, ctx) => {
    if (ctx.count === 1) { await denyOwn(url, ctx, 1); ctx.trace.recordEvent('Page.frameStartedLoading', { frameId: 'F' }); return { frameId: 'F', loaderId: 'L', errorText: 'net::ERR_BLOCKED_BY_CLIENT' }; }
    ctx.trace.recordEvent('Network.requestWillBeSent', will('N2', url));
    ctx.trace.recordEvent('Network.loadingFailed', { requestId: 'N2', type: 'Document', errorText: 'net::ERR_ABORTED', canceled: true, timestamp: 3 });
    return { frameId: 'F', loaderId: 'L2', errorText: 'net::ERR_ABORTED' };
  });
  const error = await failure(browser);
  assert.equal(error.message, 'BROWSER_AMBIENT_REQUEST_NOT_REJECTED');
  const failed = error.browserProbeDiagnostics[1];
  assert.equal(failed.verdict, 'NOT_OBSERVED'); assert.equal(failed.pass, false);
  assert.equal(failed.navigate.errorText, 'net::ERR_ABORTED');
  assert.deepEqual(failed.intercepted, []);
  // loadingFailed is present as evidence, correlated by requestId, and is not a denial.
  const network = failed.correlation.events.filter(entry => entry.method.startsWith('Network.'));
  assert.deepEqual(network.map(entry => entry.method), ['Network.requestWillBeSent', 'Network.loadingFailed']);
  assert.equal(network[1].errorText, 'net::ERR_ABORTED');
  assert.equal('networkObserved' in failed, false); // single source of truth: the requestId-correlated events
  // The previous navigation was still loading when probe 1 started: visible in the pre-state.
  assert.equal(failed.preState.eventDerived.loading, true);
  assert.deepEqual(browser.navigations, [A, B]);
});

test('a settled previous navigation is distinguishable from a still-loading one in the pre-state', async () => {
  const browser = tracedBrowser(async (url, ctx) => {
    if (ctx.count === 1) { await denyOwn(url, ctx, 1); ctx.trace.recordEvent('Page.frameStartedLoading', { frameId: 'F' }); ctx.trace.recordEvent('Page.frameStoppedLoading', { frameId: 'F' }); return { frameId: 'F', errorText: 'net::ERR_BLOCKED_BY_CLIENT' }; }
    ctx.trace.recordEvent('Network.requestWillBeSent', will('N2', url));
    return { frameId: 'F', errorText: 'net::ERR_ABORTED' };
  });
  const error = await failure(browser);
  assert.equal(error.browserProbeDiagnostics[1].preState.eventDerived.loading, false);
  assert.equal(error.browserProbeDiagnostics[1].verdict, 'NOT_OBSERVED');
});

test('an unrelated late paused/denial for another probe never satisfies this probe, even with correlated network events', async () => {
  const browser = tracedBrowser(async (url, ctx) => {
    if (ctx.count === 1) { await denyOwn(url, ctx, 1); return { frameId: 'F' }; }
    await denyOwn(A, ctx, 9); // late event carrying probe 0's URL
    ctx.trace.recordEvent('Network.requestWillBeSent', will('N2', url));
    return { frameId: 'F', errorText: 'net::ERR_ABORTED' };
  });
  const error = await failure(browser);
  assert.equal(error.browserProbeDiagnostics[1].verdict, 'NOT_OBSERVED');
  assert.deepEqual(error.browserProbeDiagnostics[1].intercepted.map(entry => [entry.url, entry.probe]), [[A, 0]]);
});

test('failure of the state capture is evidence only: a browser without trace/capture behaves exactly as before', async () => {
  const requests = [];
  const browser = { requests, brokerErrors: [], send: async (m, p) => { await denyPausedRequest(requests, { requestId: 'r', request: { url: p.url }, resourceType: 'Document', frameId: 'F' }, async () => ({}), 'S'); return { frameId: 'F' }; } };
  const results = await rehearseBrowserIsolation(browser, runtime, environment);
  assert.equal(results.length, 3); assert.ok(results.every(result => result.pass && result.preState === null || result.pass));
});

test('the correction adds no gate, retry, wait for settle, timeout change, probe change or isolation change', () => {
  const source = readFileSync(new URL('../runtime-browser.mjs', import.meta.url), 'utf8');
  assert.match(source, /const probes = \['http:\/\/127\.0\.0\.1:3000\/', 'http:\/\/localhost:9000\/', 'http:\/\/127\.0\.0\.1:5433\/'\];/);
  assert.match(source, /attempt < 100 && !evaluateAmbientProbe\(browser\.requests, start, url\)\.own\.length; attempt\+\+\) await delay\(20\)/);
  const rehearsal = source.slice(source.indexOf('export async function rehearseBrowserIsolation'), source.indexOf('export function browserSafetyNegatives'));
  assert.equal((rehearsal.match(/await delay\(/g) || []).length, 1);
  assert.equal(/for \(let (retry|attempt2)|retries|waitFor|frameStoppedLoading/i.test(rehearsal), false);
  assert.match(source, /'--network', 'none'/);
  assert.match(source, /Fetch\.enable', \{ patterns: \[\{ urlPattern: '\*', requestStage: 'Request' \}\] \}/);
  assert.match(source, /errorReason: 'BlockedByClient'/);
});
