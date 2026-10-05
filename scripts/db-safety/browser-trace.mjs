// Evidence-only CDP trace for the browser-isolation rehearsal.
// Nothing here is consulted by any pass/fail decision: an attributable
// Fetch.requestPaused followed by an explicit denial remains the only proof of
// denial. Network events are correlated by requestId, never by URL, because
// loadingFailed/loadingFinished carry no URL.

const str = value => (typeof value === 'string' ? value : null);
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Whitelisted fields only: never headers, post data, cookies or response bodies. */
const EVENT_FIELDS = {
  'Fetch.requestPaused': p => ({ requestId: str(p.requestId), networkId: str(p.networkId), frameId: str(p.frameId), resourceType: str(p.resourceType), url: str(p.request?.url), httpMethod: str(p.request?.method), responseErrorReason: str(p.responseErrorReason), responseStatusCode: num(p.responseStatusCode) }),
  'Network.requestWillBeSent': p => ({ requestId: str(p.requestId), loaderId: str(p.loaderId), frameId: str(p.frameId), resourceType: str(p.type), url: str(p.request?.url), httpMethod: str(p.request?.method), documentURL: str(p.documentURL), initiatorType: str(p.initiator?.type), redirect: Boolean(p.redirectResponse), cdpTimestamp: num(p.timestamp) }),
  'Network.loadingFailed': p => ({ requestId: str(p.requestId), resourceType: str(p.type), errorText: str(p.errorText), canceled: p.canceled === true ? true : p.canceled === false ? false : null, blockedReason: str(p.blockedReason), cdpTimestamp: num(p.timestamp) }),
  'Network.loadingFinished': p => ({ requestId: str(p.requestId), encodedDataLength: num(p.encodedDataLength), cdpTimestamp: num(p.timestamp) }),
  'Page.frameRequestedNavigation': p => ({ frameId: str(p.frameId), url: str(p.url), reason: str(p.reason), disposition: str(p.disposition) }),
  'Page.frameStartedNavigating': p => ({ frameId: str(p.frameId), url: str(p.url), loaderId: str(p.loaderId), navigationType: str(p.navigationType) }),
  'Page.frameNavigated': p => ({ frameId: str(p.frame?.id), parentId: str(p.frame?.parentId), loaderId: str(p.frame?.loaderId), url: str(p.frame?.url), unreachableUrl: str(p.frame?.unreachableUrl), mimeType: str(p.frame?.mimeType), navigationType: str(p.type) }),
  'Page.frameStartedLoading': p => ({ frameId: str(p.frameId) }),
  'Page.frameStoppedLoading': p => ({ frameId: str(p.frameId) }),
  'Page.navigatedWithinDocument': p => ({ frameId: str(p.frameId), url: str(p.url), navigationType: str(p.navigationType) }),
};
export const TRACED_EVENT_METHODS = Object.freeze(Object.keys(EVENT_FIELDS));
export const TRACED_COMMAND_METHODS = Object.freeze(['Page.navigate', 'Fetch.failRequest', 'Page.getFrameTree', 'Page.getNavigationHistory']);

export function summarizeFrameTree(result) {
  const frame = result?.frameTree?.frame;
  return frame ? { frameId: str(frame.id), loaderId: str(frame.loaderId), url: str(frame.url), unreachableUrl: str(frame.unreachableUrl), mimeType: str(frame.mimeType) } : null;
}
export function summarizeHistory(result) {
  const entries = Array.isArray(result?.entries) ? result.entries : [];
  const current = entries[result?.currentIndex] ?? null;
  return { currentIndex: num(result?.currentIndex), entryCount: entries.length, current: current ? { id: num(current.id), url: str(current.url), transitionType: str(current.transitionType) } : null };
}

const COMMAND_PARAMS = {
  'Page.navigate': p => ({ url: str(p.url) }),
  'Fetch.failRequest': p => ({ requestId: str(p.requestId), errorReason: str(p.errorReason) }),
  'Page.getFrameTree': () => ({}),
  'Page.getNavigationHistory': () => ({}),
};
const COMMAND_RESULTS = {
  'Page.navigate': r => ({ frameId: str(r?.frameId), loaderId: str(r?.loaderId), errorText: str(r?.errorText) }),
  'Fetch.failRequest': () => ({ acknowledged: true }),
  'Page.getFrameTree': r => ({ frame: summarizeFrameTree(r) }),
  'Page.getNavigationHistory': r => ({ history: summarizeHistory(r) }),
};

export function createBrowserTrace({ now = () => performance.now(), limit = 4000 } = {}) {
  const origin = now();
  const entries = [];
  let seq = 0, truncated = false;
  const loading = new Set();
  let lastNavigationEvent = null, lastFrameNavigated = null;
  const probeByUrl = new Map();

  function record(kind, method, data = {}) {
    seq += 1;
    const entry = { seq, tMs: Math.round((now() - origin) * 1000) / 1000, kind, method, ...data };
    if (entries.length < limit) entries.push(entry); else truncated = true;
    return entry;
  }
  function recordEvent(method, params = {}) {
    const pick = EVENT_FIELDS[method];
    if (!pick) return null;
    const data = pick(params || {});
    const entry = record('event', method, data);
    if (method === 'Page.frameStartedLoading' && data.frameId) loading.add(data.frameId);
    if (method === 'Page.frameStoppedLoading' && data.frameId) loading.delete(data.frameId);
    if (method === 'Page.frameRequestedNavigation' || method === 'Page.frameStartedNavigating' || method === 'Page.navigatedWithinDocument') lastNavigationEvent = { method, seq: entry.seq, url: data.url, frameId: data.frameId };
    if (method === 'Page.frameNavigated') lastFrameNavigated = { seq: entry.seq, url: data.url, unreachableUrl: data.unreachableUrl, frameId: data.frameId };
    return entry;
  }
  function recordCommand(method, params = {}) {
    const pick = COMMAND_PARAMS[method];
    return pick ? record('command', method, pick(params || {})) : null;
  }
  function recordResult(method, params = {}, result = null, error = null) {
    const pick = COMMAND_RESULTS[method];
    if (!pick) return null;
    const request = COMMAND_PARAMS[method](params || {});
    const code = error ? (/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'CDP_COMMAND_ERROR') : null;
    return record('command-result', method, { ...request, ...(error ? { error: code } : pick(result)) });
  }
  function mark(label, data = {}) {
    if (label === 'probe-start' && typeof data.url === 'string' && Number.isInteger(data.probe)) probeByUrl.set(new URL(data.url).href, data.probe);
    return record('mark', label, data);
  }
  /** Event-derived state: no CDP command, so reading it cannot perturb navigation timing. */
  function state() {
    return { loading: loading.size > 0, loadingFrames: [...loading], lastNavigationEvent, lastFrameNavigated, nextSeq: seq + 1 };
  }
  /** Probe identity comes from the URL registered at probe start, never from window position. */
  function probeFor(url) {
    try { return probeByUrl.get(new URL(url).href) ?? null; } catch { return null; }
  }
  function slice(fromSeq, toSeq) { return entries.filter(entry => entry.seq >= fromSeq && entry.seq <= toSeq); }

  /** Join by requestId (Network.*), by networkId (Fetch.requestPaused) and by Fetch requestId (failRequest). URL is used only to find the starting requests. */
  function correlate(probeUrl) {
    const href = new URL(probeUrl).href;
    const networkIds = new Set(), fetchIds = new Set();
    for (const entry of entries) {
      if (entry.kind !== 'event' || entry.url !== href) continue;
      if (entry.method === 'Network.requestWillBeSent' && entry.requestId) networkIds.add(entry.requestId);
      if (entry.method === 'Fetch.requestPaused') { if (entry.networkId) networkIds.add(entry.networkId); if (entry.requestId) fetchIds.add(entry.requestId); }
    }
    const related = entries.filter(entry => {
      if (entry.kind === 'event') {
        if (entry.method.startsWith('Network.')) return networkIds.has(entry.requestId);
        if (entry.method === 'Fetch.requestPaused') return fetchIds.has(entry.requestId);
        return entry.url === href || entry.unreachableUrl === href;
      }
      if ((entry.kind === 'command' || entry.kind === 'command-result') && entry.method === 'Fetch.failRequest') return fetchIds.has(entry.requestId);
      return false;
    });
    return { probeUrl: href, networkRequestIds: [...networkIds], fetchRequestIds: [...fetchIds], events: related };
  }
  function snapshot() { return { entries: [...entries], truncated, count: entries.length, limit }; }

  return { record, recordEvent, recordCommand, recordResult, mark, state, probeFor, slice, correlate, snapshot, get entries() { return entries; } };
}
