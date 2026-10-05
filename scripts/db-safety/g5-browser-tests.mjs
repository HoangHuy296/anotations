// Verification-only DOM interactions through the receipt-owned, network-isolated
// browser. No product instrumentation, browser package, ambient target or DB write.
import assert from 'node:assert/strict';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const literal = value => JSON.stringify(value);
const titled = modality => modality[0] + modality.slice(1).toLowerCase();

export async function runBrowserChecks({ browser, base, cookie, fixtures, results, request, db }) {
  assert.equal(new URL(base).hostname, '127.0.0.1');
  assert.equal(fixtures.resolved.length, 4);
  assert.equal(fixtures.emptyResolved.length, 4);
  const cases = [];
  async function run(name, action) {
    const started = Date.now();
    try {
      const evidence = await action();
      const receipt = { name: `G5 browser: ${name}`, status: 'PASS', durationMs: Date.now() - started, ...evidence };
      cases.push(receipt); results.push(receipt);
    } catch (error) {
      results.push({ name: `G5 browser: ${name}`, status: 'FAIL', durationMs: Date.now() - started, dom: await snapshot().catch(() => null) });
      throw error;
    }
  }
  async function wait(expression, message, timeout = 90000) {
    const deadline = Date.now() + timeout;
    let value;
    do {
      value = await browser.evaluate(expression);
      if (value) return value;
      await delay(300);
    } while (Date.now() < deadline);
    assert.fail(message);
  }
  async function waitDb(read, predicate, message, timeout = 20000) {
    const deadline = Date.now() + timeout;
    do { const value = await read(); if (predicate(value)) return value; await delay(250); } while (Date.now() < deadline);
    assert.fail(message);
  }
  const snapshot = () => browser.evaluate(`({path:location.pathname,search:location.search,engines:[...document.querySelectorAll('[data-workspace-engine]')].map(e=>({modality:e.dataset.workspaceEngine,dataset:e.dataset.workspaceDataset})),unresolved:[...document.querySelectorAll('[data-workspace-unresolved]')].map(e=>e.dataset.workspaceUnresolved),toolboxes:[...document.querySelectorAll('aside[aria-label]')].map(e=>e.getAttribute('aria-label')),tabs:[...document.querySelectorAll('nav[aria-label$=" management"] button')].map(e=>({text:e.textContent.trim(),selected:e.getAttribute('aria-current')})),title:document.querySelector('h1')?.textContent?.trim()})`);
  function findText(selector, text) { return `[...document.querySelectorAll(${literal(selector)})].find(e=>e.textContent.trim()===${literal(text)})`; }
  async function clickExpression(expression) {
    const rect = await browser.evaluate(`(()=>{const e=${expression};if(!e||e.disabled)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`);
    assert.ok(rect, `Browser target unavailable: ${expression}`);
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rect });
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 });
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 });
  }
  const click = selector => clickExpression(`document.querySelector(${literal(selector)})`);
  const clickText = (selector, text) => clickExpression(findText(selector, text));
  async function key(key, code, extra = {}) {
    const windowsVirtualKeyCode={Enter:13,Home:36,ArrowDown:40}[key];
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, ...(windowsVirtualKeyCode?{windowsVirtualKeyCode}:{}), ...extra });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, ...(windowsVirtualKeyCode?{windowsVirtualKeyCode}:{}), ...extra });
  }
  async function type(selector, text) {
    await click(selector);
    await key('a', 'KeyA', { modifiers: 2, windowsVirtualKeyCode: 65 });
    await browser.send('Input.insertText', { text });
  }
  async function setCookie(value) {
    const [name, ...rest] = value.split('=');
    assert.ok(name && rest.length);
    const receipt = await browser.send('Network.setCookie', { name, value: rest.join('='), url: base, path: '/', httpOnly: true, sameSite: 'Lax' });
    assert.equal(receipt.success, true);
  }
  async function engine(dataset) {
    await wait(`document.querySelector('[data-workspace-engine]')?.dataset.workspaceDataset===${literal(dataset.id)}`, 'Dataset engine did not mount');
    await wait(`document.readyState==='complete'`, 'Workspace document did not finish loading');
    const state = await snapshot();
    assert.deepEqual(state.engines, [{ modality: dataset.modality, dataset: dataset.id }]);
    assert.ok(state.toolboxes.includes(`${titled(dataset.modality)} annotation tools`));
    assert.equal(state.unresolved.length, 0);
    return state;
  }
  async function hydrate(dataset) {
    const tool = dataset.modality === 'TEXT' ? 'Scroll' : 'Pan';
    const selector = `aside[aria-label="${titled(dataset.modality)} annotation tools"] button[aria-label="${tool}"]`;
    // SSR is not hydration evidence. An idempotent user tool action can be
    // repeated while the real bundle hydrates, but no state is injected.
    for (let attempt = 0; attempt < 5; attempt++) {
      await click(selector);
      if (await browser.evaluate(`document.querySelector(${literal(selector)})?.getAttribute('aria-pressed')==='true'`)) break;
      await delay(600);
    }
    await wait(`document.querySelector(${literal(selector)})?.getAttribute('aria-pressed')==='true'`, 'Tool hydration did not respond');
  }
  async function tab(name) {
    await clickText('nav[aria-label$=" management"] button', name);
    await wait(`(()=>{const e=${findText('nav[aria-label$=" management"] button', name)};return e&&(e.getAttribute('aria-current')==='page'||e.getAttribute('aria-selected')==='true'||e.className.includes('border-sky'))})()`, `Tab ${name} did not activate`);
  }
  async function clientDataset(dataset) {
    await click('[aria-label="Back to datasets"]');
    await wait(`location.pathname==='/datasets'&&document.querySelector('section[aria-label="Dataset list"]')`, 'Client catalog navigation failed');
    const selector = `a[aria-label=${literal(`Open ${dataset.name}`)}]`;
    await wait(`document.querySelector(${literal(selector)})`, 'Dataset absent from catalog page');
    await click(selector);
    await wait(`location.pathname===${literal(`/workspace/${dataset.id}`)}`, 'Client Dataset link failed');
    return engine(dataset);
  }

  await setCookie(cookie);
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
  for (const dataset of fixtures.emptyResolved) await run(`empty ${dataset.modality} engine and hydrated toolbox`, async () => {
    await browser.navigate(`${base}/workspace/${dataset.id}`);
    const state = await engine(dataset);
    await hydrate(dataset);
    assert.equal(state.tabs.length, 0);
    assert.equal(await browser.evaluate(`!!document.querySelector('canvas,video,audio,pre')`), false);
    const safe = await request(`/api/datasets/${dataset.id}/workspace-state`, undefined, 200, 'GET');
    assert.equal(safe.data.modality, dataset.modality);
    assert.equal(safe.data.modalityResolution, 'RESOLVED');
    return { dom: await snapshot(), noContentElement: true };
  });

  for (const dataset of fixtures.resolved) await run(`selected ${dataset.modality} tabs, tools and status`, async () => {
    assert.ok(dataset.assets?.length, `Missing ${dataset.modality} selection fixture`);
    await browser.navigate(`${base}/workspace/${dataset.id}?${dataset.modality.toLowerCase()}=${dataset.assets[0]}`);
    await engine(dataset); await hydrate(dataset);
    await wait(`document.querySelectorAll('nav[aria-label$=" management"] button').length===4`, 'Management tabs missing');
    const expected = ['description', 'labels', dataset.modality === 'IMAGE' ? 'shapes' : dataset.modality === 'TEXT' ? 'annotations' : 'tracks', 'assets'];
    assert.deepEqual((await snapshot()).tabs.map(item => item.text.toLowerCase()), expected);
    for (const name of expected) await tab(name);
    await tab('description');
    if (dataset.modality === 'TEXT') await wait(`document.querySelector('pre')?.textContent.includes('OpenAI builds AI.')`, 'Published TEXT reader did not hydrate');
    const header = await browser.evaluate(`document.querySelector('header')?.textContent||''`);
    assert.ok(header.includes(titled(dataset.modality)), 'Header omitted Dataset modality status');
    return { dom: await snapshot(), mediaCoverage: ['VIDEO', 'AUDIO'].includes(dataset.modality) ? 'Existing pending-media engine surface; playback/editing not claimed' : 'Published content and selected engine', ...(dataset.modality === 'AUDIO' ? { legacyLimitation: 'Audio properties navigation retains the existing Video management aria-label' } : {}) };
  });

  const image = fixtures.resolved.find(item => item.modality === 'IMAGE');
  const text = fixtures.resolved.find(item => item.modality === 'TEXT');
  await run('query cannot override Dataset engine; client Dataset changes reset state', async () => {
    await browser.navigate(`${base}/workspace/${image.id}?video=${image.assets[0]}`);
    await engine(image); await hydrate(image);
    // Browser object identity is held by CDP, never injected into product code.
    const handle = await browser.send('Runtime.evaluate', { expression: `document.querySelector('[data-workspace-engine]')`, returnByValue: false });
    assert.ok(handle.result.objectId);
    const toText = await clientDataset(text);
    assert.ok(!toText.toolboxes.includes('Image annotation tools'));
    const same = await browser.send('Runtime.callFunctionOn', { objectId: handle.result.objectId, functionDeclaration: `function(){return this===document.querySelector('[data-workspace-engine]')}`, returnByValue: true });
    assert.equal(same.result.value, false);
    await clientDataset(image); await hydrate(image);
    await browser.send('Runtime.releaseObject', { objectId: handle.result.objectId });
    return { from: image.id, to: text.id, return: image.id, clientLinks: true, boundaryReset: true, dom: await snapshot() };
  });

  await run('image canvas action, annotation revisions and draft-flush Asset navigation', async () => {
    assert.ok(image.assets.length >= 2 && image.width > 1 && image.height > 1 && image.imageLabelId);
    const assetId = image.assets[0], nextId = image.assets[1];
    await browser.navigate(`${base}/workspace/${image.id}?image=${assetId}`);
    await engine(image);
    const start = await browser.evaluate(`(()=>{const e=[...document.querySelectorAll('header button')].find(e=>e.textContent.trim()==='Start');return !!e&&!e.disabled})()`);
    if (start) { await clickText('header button', 'Start'); await wait(`![...document.querySelectorAll('header button')].some(e=>e.textContent.trim()==='Start'&&!e.disabled)`, 'Workflow start did not complete'); }
    await wait(`document.querySelector('.konvajs-content canvas')`, 'Real image canvas did not load');
    const priorIds = new Set((await db.annotation.findMany({ where: { assetId }, select: { id: true } })).map(item => item.id));
    await click('aside[aria-label="Image annotation tools"] button[aria-label="Bounding box"]');
    const rect = await browser.evaluate(`(()=>{const r=document.querySelector('.konvajs-content').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
    const scale = Math.min(Math.max(1, rect.width - 96) / image.width, Math.max(1, rect.height - 96) / image.height, 1);
    const x = rect.x + (rect.width - image.width * scale) / 2 + image.width * scale * 0.65;
    const y = rect.y + (rect.height - image.height * scale) / 2 + image.height * scale * 0.65;
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + image.width * scale * 0.2, y: y + image.height * scale * 0.2, button: 'left', buttons: 1 });
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + image.width * scale * 0.2, y: y + image.height * scale * 0.2, button: 'left', clickCount: 1 });
    const created = await waitDb(() => db.annotation.findMany({ where: { assetId }, select: { id: true, revision: true, labelId: true, geometry: true, type: true } }), rows => rows.some(item => !priorIds.has(item.id)), 'Canvas action was not persisted');
    const annotation = created.find(item => !priorIds.has(item.id));
    assert.equal(annotation.type, 'BOUNDING_BOX'); assert.equal(annotation.revision, 1); assert.equal(annotation.labelId, image.imageLabelId);
    assert.ok(annotation.geometry.width > 0 && annotation.geometry.height > 0 && annotation.geometry.x + annotation.geometry.width <= 1 && annotation.geometry.y + annotation.geometry.height <= 1);
    await tab('shapes');
    await click(`select[aria-label="Label for ${annotation.id}"]`); await key('Home', 'Home'); await key('Enter', 'Enter');
    const updated = await waitDb(() => db.annotation.findUnique({ where: { id: annotation.id }, select: { revision: true, labelId: true } }), item => item?.revision === 2 && item.labelId === null, 'Annotation label autosave/revision did not persist');
    const stale = await request(`/api/assets/${assetId}/annotations`, { updates: [{ id: annotation.id, revision: 1, labelId: image.imageLabelId }] }, 409, 'PUT');
    assert.equal(stale.json.error.code, 'ANNOTATION_REVISION_CONFLICT');
    assert.deepEqual(await db.annotation.findUnique({ where: { id: annotation.id }, select: { revision: true, labelId: true } }), updated);
    const handle = await browser.send('Runtime.evaluate', { expression: `document.querySelector('[data-workspace-engine]')`, returnByValue: false });
    await tab('description');
    const before = await db.asset.findUnique({ where: { id: assetId }, select: { version: true } });
    const description = 'G5 browser draft flushed before selecting another image';
    await type('textarea[placeholder="Scene context, notes, or quality flags"]', description);
    await tab('assets');
    await click(`a[href*="image=${nextId}"]`);
    await wait(`new URL(location.href).searchParams.get('image')===${literal(nextId)}`, 'Asset navigation failed'); await engine(image);
    const saved = await db.asset.findUnique({ where: { id: assetId }, select: { description: true, version: true } });
    assert.equal(saved.description, description); assert.equal(saved.version, before.version + 1);
    const same = await browser.send('Runtime.callFunctionOn', { objectId: handle.result.objectId, functionDeclaration: `function(){return this===document.querySelector('[data-workspace-engine]')}`, returnByValue: true });
    assert.equal(same.result.value, true); await browser.send('Runtime.releaseObject', { objectId: handle.result.objectId });
    return { dataset: image.id, assetId, nextId, annotationId: annotation.id, canonicalGeometry: annotation.geometry, createdRevision: 1, updatedRevision: updated.revision, staleStatus: 409, descriptionVersion: saved.version, stableDatasetEngineBoundary: true, dom: await snapshot() };
  });

  for (const [field, state] of [['empty', 'EMPTY_UNRESOLVED'], ['mixed', 'MIXED_UNRESOLVED'], ['single', 'SINGLE_UNRESOLVED']]) await run(`${state} stays unresolved without an engine`, async () => {
    await browser.navigate(`${base}/workspace/${fixtures.history[field]}?video=${image.assets[0]}`);
    await wait(`document.querySelector('[data-workspace-unresolved]')?.dataset.workspaceUnresolved===${literal(state)}`, 'Unresolved state UI missing');
    const dom = await snapshot(); assert.equal(dom.engines.length, 0); assert.equal(dom.toolboxes.length, 0);
    assert.equal(await browser.evaluate(`!!document.querySelector('form[aria-label="Resolve empty dataset modality"]')`), field === 'empty');
    const row = await db.dataset.findUnique({ where: { id: fixtures.history[field] }, select: { modality: true, modalityResolvedAt: true, modalityResolverSubject: true } });
    assert.deepEqual(row, { modality: null, modalityResolvedAt: null, modalityResolverSubject: null });
    return { state, dom, noInference: true };
  });

  await run('manager cannot resolve EMPTY through UI or HTTP', async () => {
    await setCookie(fixtures.managerCookie); await browser.navigate(`${base}/workspace/${fixtures.managerDeniedDataset}`);
    await wait(`document.querySelector('[data-workspace-unresolved]')`, 'Manager unresolved page missing');
    assert.equal(await browser.evaluate(`!!document.querySelector('form[aria-label="Resolve empty dataset modality"]')`), false);
    const response = await browser.evaluate(`fetch(${literal(`/api/datasets/${fixtures.managerDeniedDataset}/modality-resolution`)},{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({modality:'IMAGE'})}).then(async r=>({status:r.status,code:(await r.json()).error?.code}))`);
    assert.deepEqual(response, { status: 403, code: 'FORBIDDEN' });
    assert.equal((await db.dataset.findUnique({ where: { id: fixtures.managerDeniedDataset }, select: { modality: true } })).modality, null);
    return { status: response.status, code: response.code, noResolutionControl: true, dom: await snapshot() };
  });

  await run('owner explicitly resolves EMPTY then mounts server-refreshed engine', async () => {
    await setCookie(cookie); await browser.navigate(`${base}/workspace/${fixtures.history.empty}`);
    await wait(`document.querySelector('form[aria-label="Resolve empty dataset modality"]')`, 'Owner resolution control missing');
    const initial = await snapshot(); assert.equal(initial.engines.length, 0);
    assert.equal(await browser.evaluate(`document.querySelector('#dataset-modality')?.value || document.querySelector('form select')?.value`), '');
    await click('form[aria-label="Resolve empty dataset modality"] select');
    await key('Home', 'Home'); await key('ArrowDown', 'ArrowDown'); await key('ArrowDown', 'ArrowDown'); await key('Enter', 'Enter');
    assert.equal(await browser.evaluate(`document.querySelector('form select').value`), 'VIDEO');
    assert.equal((await snapshot()).engines.length, 0);
    await click('form[aria-label="Resolve empty dataset modality"] input[type="checkbox"]');
    assert.equal((await snapshot()).engines.length, 0);
    const index = browser.requests.length;
    await clickText('form button', 'Confirm dataset modality');
    await wait(`document.querySelector('[data-workspace-engine]')?.dataset.workspaceEngine==='VIDEO'`, 'Server refresh did not mount resolved engine');
    const calls = browser.requests.slice(index).filter(item => item.path === `/api/datasets/${fixtures.history.empty}/modality-resolution` && item.method === 'POST');
    assert.equal(calls.length, 1); assert.equal(calls[0].status, 200);
    const receipt = await request(`/api/datasets/${fixtures.history.empty}/workspace-state`, undefined, 200, 'GET');
    assert.equal(receipt.data.modality, 'VIDEO'); assert.equal(receipt.data.modalityResolution, 'RESOLVED');
    const row = await db.dataset.findUnique({ where: { id: fixtures.history.empty }, select: { modality: true, modalityResolvedAt: true, modalityResolverSubject: true } });
    assert.equal(row.modality, 'VIDEO'); assert.ok(row.modalityResolvedAt); assert.equal(row.modalityResolverSubject, fixtures.history.owner);
    return { explicitChoice: 'VIDEO', noOptimisticEngine: true, terminalPostStatus: 200, serverReadModality: receipt.data.modality, immutableReceipt: true, dom: await snapshot() };
  });
  assert.equal(browser.brokerErrors.length, 0);
  return { version: browser.version, cases, brokerErrors: browser.brokerErrors, requests: browser.requests };
}
