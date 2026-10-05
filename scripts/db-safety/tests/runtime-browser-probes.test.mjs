import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeDeniedRequest, denyPausedRequest, evaluateAmbientProbe, rehearseBrowserIsolation } from '../runtime-browser.mjs';

// Fake CDP: no browser, container, network or database. Requests are recorded exactly as the broker records them.
const runtime = { roles: { web: { port: 55463 } } };
const environment = { MINIO_ENDPOINT: 'http://127.0.0.1:55462' };
const PROBES = ['http://127.0.0.1:3000/', 'http://localhost:9000/', 'http://127.0.0.1:5433/'];
const pausedEvent = (url, n = 1) => ({ requestId: `r${n}`, request: { url }, resourceType: 'Document', frameId: 'FRAME' });

function fakeBrowser(onNavigate) {
  const requests = [], network = [], sent = [], navigations = [];
  const send = async (method, params) => { sent.push({ method, params }); return { ok: true }; };
  return {
    requests, network, sent, navigations, brokerErrors: [],
    send: async (method, params) => {
      assert.equal(method, 'Page.navigate');
      navigations.push(params.url);
      return onNavigate(params.url, { requests, network, send, navigations, count: navigations.length });
    },
  };
}
const rejection = async (browser) => {
  let caught;
  await rehearseBrowserIsolation(browser, runtime, environment).catch(error => { caught = error; });
  assert.ok(caught, 'rehearsal must reject');
  return caught;
};
const denyOwn = (url, { requests, send }, n) => denyPausedRequest(requests, pausedEvent(url, n), send, 'SESSION');

test('a correctly attributed paused request followed by failRequest(BlockedByClient) satisfies exactly its own probe', async () => {
  const browser = fakeBrowser(async (url, ctx) => { await denyOwn(url, ctx, ctx.count); return { frameId: 'FRAME', loaderId: 'L', errorText: 'net::ERR_BLOCKED_BY_CLIENT' }; });
  const results = await rehearseBrowserIsolation(browser, runtime, environment);
  assert.equal(results.length, 3);
  results.forEach((result, index) => {
    assert.equal(result.pass, true); assert.equal(result.verdict, 'DENIED_OBSERVED'); assert.equal(result.probe, index);
    assert.equal(result.url, PROBES[index]); assert.equal(result.navigate.errorText, 'net::ERR_BLOCKED_BY_CLIENT');
    assert.deepEqual(result.intercepted.map(entry => entry.url), [PROBES[index]]);
    assert.deepEqual(result.intercepted[0], { allowed: false, error: 'BROWSER_RESOURCE_TARGET_DENIED', url: PROBES[index], origin: new URL(PROBES[index]).origin, resourceType: 'Document', frameId: 'FRAME' });
  });
  assert.deepEqual(browser.navigations, PROBES);
  assert.equal(browser.sent.filter(call => call.method === 'Fetch.failRequest' && call.params.errorReason === 'BlockedByClient').length, 3);
});

test('a denial for one probe never satisfies another probe', () => {
  const requests = [describeDeniedRequest(pausedEvent(PROBES[0]))];
  assert.equal(evaluateAmbientProbe(requests, 0, PROBES[0]).verdict, 'DENIED_OBSERVED');
  assert.equal(evaluateAmbientProbe(requests, 0, PROBES[1]).verdict, 'NOT_OBSERVED');
  assert.equal(evaluateAmbientProbe(requests, 0, PROBES[2]).verdict, 'NOT_OBSERVED');
  // An entry recorded before the probe began is outside its window.
  assert.equal(evaluateAmbientProbe(requests, 1, PROBES[0]).verdict, 'NOT_OBSERVED');
});

test('no paused request: fails with per-probe NOT_OBSERVED and never reaches the next probe', async () => {
  const browser = fakeBrowser(async () => ({ frameId: 'FRAME', loaderId: 'L' }));
  const error = await rejection(browser);
  assert.equal(error.message, 'BROWSER_AMBIENT_REQUEST_NOT_REJECTED');
  assert.equal(error.browserProbeDiagnostics.length, 1);
  assert.equal(error.browserProbeDiagnostics[0].probe, 0); assert.equal(error.browserProbeDiagnostics[0].verdict, 'NOT_OBSERVED');
  assert.equal(error.browserProbeDiagnostics[0].url, PROBES[0]);
  assert.deepEqual(browser.navigations, [PROBES[0]]);
});

test('successful Page.navigate, a navigation errorText or a Network.loadingFailed event are not proof of denial', async () => {
  for (const navigate of [{ frameId: 'FRAME', loaderId: 'L' }, { frameId: 'FRAME', errorText: 'net::ERR_BLOCKED_BY_CLIENT' }, { frameId: 'FRAME', errorText: 'net::ERR_CONNECTION_REFUSED' }]) {
    const browser = fakeBrowser(async (url, { network }) => {
      network.push({ method: 'Network.requestWillBeSent', url, requestId: 'n1', frameId: 'FRAME', resourceType: 'Document', errorText: null, blockedReason: null });
      network.push({ method: 'Network.loadingFailed', url, requestId: 'n1', frameId: 'FRAME', resourceType: 'Document', errorText: 'net::ERR_BLOCKED_BY_CLIENT', blockedReason: 'inspector' });
      return navigate;
    });
    const error = await rejection(browser);
    assert.equal(error.browserProbeDiagnostics[0].verdict, 'NOT_OBSERVED');
    // Network events are retained as evidence only.
    assert.equal(error.browserProbeDiagnostics[0].networkObserved.length, 2);
    assert.equal(error.browserProbeDiagnostics[0].intercepted.length, 0);
  }
});

test('a late event from the preceding probe cannot satisfy the next probe', async () => {
  const browser = fakeBrowser(async (url, ctx) => {
    if (ctx.count === 1) { await denyOwn(url, ctx, 1); return { frameId: 'FRAME' }; }
    // Probe 2 produces nothing of its own; probe 1's request is only now (late) recorded again.
    ctx.requests.push(describeDeniedRequest(pausedEvent(PROBES[0], 9)));
    return { frameId: 'FRAME' };
  });
  const error = await rejection(browser);
  assert.equal(error.message, 'BROWSER_AMBIENT_REQUEST_NOT_REJECTED');
  assert.equal(error.browserProbeDiagnostics.length, 2);
  assert.equal(error.browserProbeDiagnostics[0].pass, true);
  const failed = error.browserProbeDiagnostics[1];
  assert.equal(failed.probe, 1); assert.equal(failed.verdict, 'NOT_OBSERVED');
  assert.deepEqual(failed.intercepted.map(entry => entry.url), [PROBES[0]]);
  assert.deepEqual(browser.navigations, [PROBES[0], PROBES[1]]);
});

test('an ambient request that was allowed or fulfilled is a failure, never a pass', async () => {
  const browser = fakeBrowser(async (url, { requests }) => {
    requests.push({ allowed: true, origin: new URL(url).origin, path: '/', method: 'GET', status: 200, url: new URL(url).href, resourceType: 'Document', frameId: 'FRAME' });
    return { frameId: 'FRAME' };
  });
  const error = await rejection(browser);
  assert.equal(error.message, 'BROWSER_AMBIENT_REQUEST_NOT_REJECTED');
  assert.equal(error.browserProbeDiagnostics[0].verdict, 'ALLOWED');
  assert.equal(error.browserProbeDiagnostics[0].pass, false);
  assert.deepEqual(browser.navigations, [PROBES[0]]);
});

test('a denial lacking URL attribution is rejected and no URL is ever invented', async () => {
  const record = describeDeniedRequest({ requestId: 'r1', request: {}, resourceType: 'Document', frameId: 'FRAME' });
  assert.equal(record.url, null); assert.equal(record.origin, null); assert.equal(record.allowed, false);
  assert.equal(describeDeniedRequest(undefined).url, null);
  assert.equal(describeDeniedRequest({ request: { url: 'not a url' } }).url, null);
  const browser = fakeBrowser(async (url, { requests }) => { requests.push(record); return { frameId: 'FRAME' }; });
  const error = await rejection(browser);
  assert.equal(error.message, 'BROWSER_AMBIENT_REQUEST_NOT_REJECTED');
  assert.equal(error.browserProbeDiagnostics[0].verdict, 'UNATTRIBUTED');
  // Even alongside a properly attributed denial, an unattributed entry in the window still fails.
  const mixed = fakeBrowser(async (url, ctx) => { await denyOwn(url, ctx, 1); ctx.requests.push(record); return { frameId: 'FRAME' }; });
  assert.equal((await rejection(mixed)).browserProbeDiagnostics[0].verdict, 'UNATTRIBUTED');
});

test('a broker error still fails the rehearsal with the per-probe record retained', async () => {
  const browser = fakeBrowser(async (url, ctx) => { await denyOwn(url, ctx, ctx.count); if (ctx.count === 2) browser.brokerErrors.push({ error: 'BROWSER_RESOURCE_BROKER_FAILED' }); return { frameId: 'FRAME' }; });
  const error = await rejection(browser);
  assert.equal(error.message, 'BROWSER_SAFETY_REHEARSAL_FAILED');
  assert.equal(error.browserProbeDiagnostics.length, 2);
  assert.deepEqual(browser.navigations, [PROBES[0], PROBES[1]]);
});

test('a Page.navigate failure is recorded and cannot pass the probe', async () => {
  const browser = fakeBrowser(async () => { throw Error('BROWSER_CDP_COMMAND_FAILED'); });
  const error = await rejection(browser);
  assert.equal(error.browserProbeDiagnostics[0].navigate.threw, 'BROWSER_CDP_COMMAND_FAILED');
  assert.equal(error.browserProbeDiagnostics[0].verdict, 'NOT_OBSERVED');
});

test('an allowed origin is refused before any navigation (boundary unchanged)', async () => {
  const browser = fakeBrowser(async () => { throw Error('must not navigate'); });
  await assert.rejects(rehearseBrowserIsolation(browser, { roles: { web: { port: 3000 } } }, environment));
  assert.deepEqual(browser.navigations, []);
});

test('timeout, network policy and ownership gates are unchanged in the source', () => {
  const source = readFileSync(new URL('../runtime-browser.mjs', import.meta.url), 'utf8');
  assert.match(source, /attempt < 100 && !evaluateAmbientProbe\(browser\.requests, start, url\)\.own\.length; attempt\+\+\) await delay\(20\)/);
  assert.match(source, /'--network', 'none'/);
  assert.match(source, /BROWSER_CONTAINER_ISOLATION_MISMATCH/);
  assert.match(source, /Fetch\.enable', \{ patterns: \[\{ urlPattern: '\*', requestStage: 'Request' \}\] \}/);
  assert.match(source, /errorReason: 'BlockedByClient'/);
});
