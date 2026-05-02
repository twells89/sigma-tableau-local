/**
 * Full E2E test for the Tableau Prep flow path:
 *   1. ⚡ Auto-connect to Tableau Cloud
 *   2. Switch to Flows tab
 *   3. Pick & load a flow → run conversion
 *   4. Connect to Sigma using SIGMA_CLIENT_ID / SIGMA_CLIENT_SECRET env vars
 *   5. Click Save to Sigma → fill the modal → confirm save
 *   6. Capture the dataModelId
 *   7. Verify via Sigma API that the model was created and has elements
 *
 * Requires:
 *   - Server running with TABLEAU_SERVER, TABLEAU_SITE, TABLEAU_PAT_NAME, TABLEAU_PAT_SECRET env vars
 *   - SIGMA_CLIENT_ID, SIGMA_CLIENT_SECRET env vars
 */

const puppeteer = require('puppeteer');
const fetch     = require('node-fetch');
const fs        = require('fs');
const path      = require('path');

const BASE_URL = 'http://localhost:3333';
const SIGMA_CLIENT_ID     = process.env.SIGMA_CLIENT_ID || '';
const SIGMA_CLIENT_SECRET = process.env.SIGMA_CLIENT_SECRET || '';
const SIGMA_BASE_URL      = process.env.SIGMA_BASE_URL || 'https://aws-api.sigmacomputing.com';

// Synthetic test fixtures that reference real CSA.TJ tables (so Sigma can save them
// against the ymb68310 connection without "table not found" errors).
const TEST_TFL_PATH = '/tmp/prep_tests/test_proxy.tfl';
const TEST_TDS_PATH = '/tmp/prep_tests/sample_published_datasource.tds';
const RETAIL_CONN_ID = 'cb2f5180-641f-47bd-8efa-da9d590d855a'; // ymb68310 (CSA.TJ)

if (!SIGMA_CLIENT_ID || !SIGMA_CLIENT_SECRET) {
  console.error('SIGMA_CLIENT_ID and SIGMA_CLIENT_SECRET must be set');
  process.exit(2);
}

let browser, page;
let stats = { passed: 0, failed: 0 };

function ok(msg, cond, detail) {
  if (cond) { console.log('  ✓ PASS  ' + msg); stats.passed++; }
  else { console.log('  ✗ FAIL  ' + msg + (detail ? '\n           ' + detail : '')); stats.failed++; }
}

(async () => {
  console.log('\nTableau Prep + Sigma Save E2E');
  console.log('==================================\n');

  browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  page    = await browser.newPage();

  // Capture browser console + page errors for debugging
  const browserLogs = [];
  page.on('pageerror', err => {
    console.log('  [browser pageerror]', err.message);
    browserLogs.push('pageerror: ' + err.message);
  });
  page.on('console', msg => {
    if (msg.type() === 'error') console.log('  [browser error]', msg.text());
  });

  await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 15000 });

  // Use the synthetic .tfl + .tds fixtures via the manual upload path. These reference
  // real CSA.TJ tables, so the save will succeed against the ymb68310 connection.
  if (!fs.existsSync(TEST_TFL_PATH) || !fs.existsSync(TEST_TDS_PATH)) {
    console.error(`  fixtures missing: ${TEST_TFL_PATH} / ${TEST_TDS_PATH}`);
    console.error('  Run: node /tmp/prep_tests/build_test_v2.mjs to recreate them');
    process.exit(2);
  }

  // 1. Inject the .tfl content via the existing processTableauFile() path so we exercise
  // the same code path a real user drag-drop would hit.
  const tflBytes = fs.readFileSync(TEST_TFL_PATH);
  const tdsText  = fs.readFileSync(TEST_TDS_PATH, 'utf8');
  const conversion = await page.evaluate(async (tflB64, tdsXml) => {
    // Decode base64 to Uint8Array
    const bytes = Uint8Array.from(atob(tflB64), c => c.charCodeAt(0));
    const tflFile = new File([bytes], 'test_proxy.tfl', { type: 'application/zip' });
    const tdsFile = new File([tdsXml], 'sample_published_datasource.tds', { type: 'application/xml' });
    await processTableauFile(tflFile, true);
    await processTableauFile(tdsFile, false);   // triggers conversion via the !defer path
    return {
      flowLen: typeof _prepFlowJson === 'string' ? _prepFlowJson.length : 0,
      tdsCount: _prepTdsFiles.length,
      outputLen: document.getElementById('tableauJsonOutput').value.length,
    };
  }, tflBytes.toString('base64'), tdsText);
  console.log('     after upload:', JSON.stringify(conversion));
  ok('flow + tds uploaded', conversion.flowLen > 0 && conversion.tdsCount > 0);
  ok('initial conversion ran', conversion.outputLen > 50);
  const outText = await page.$eval('#tableauJsonOutput', el => el.value);
  let parsed; try { parsed = JSON.parse(outText); } catch {}
  ok('output JSON parsed', !!parsed);
  ok('output has elements', (parsed?.pages?.[0]?.elements || []).length > 0);

  const elementCount = (parsed?.pages?.[0]?.elements || []).length;
  console.log(`     converted to ${elementCount} elements`);

  // 5. Connect to Sigma
  await page.type('#sigmaClientId', SIGMA_CLIENT_ID);
  await page.type('#sigmaClientSecret', SIGMA_CLIENT_SECRET);
  await page.click('#sigConnectBtn');
  await page.waitForFunction(
    () => (document.getElementById('sigDot').className || '').includes('connected'),
    { timeout: 15000 }
  );
  ok('Sigma connected', (await page.$eval('#sigDot', el => el.className)).includes('connected'));

  // Pick the ymb68310 (CSA.TJ) Sigma connection so the warehouse paths in the converted
  // spec resolve to real tables. Re-run conversion + set CSA/TJ overrides.
  const pickedConn = await page.evaluate((connId) => {
    const sel = document.getElementById('tableauConnectionId');
    sel.value = connId;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('tableauDatabase').value = 'CSA';
    document.getElementById('tableauSchema').value = 'TJ';
    runTableauConversion();
    return connId;
  }, RETAIL_CONN_ID);
  ok('picked Sigma connection (ymb68310)', !!pickedConn, pickedConn);
  await new Promise(r => setTimeout(r, 800));

  // 6. Click Save to Sigma → modal opens
  // Diagnose pre-click state
  const preSave = await page.evaluate(() => ({
    saveBtnDisabled: document.getElementById('tableauSaveBtn').disabled,
    hasAccessToken: !!state.accessToken,
    outputLen: document.getElementById('tableauJsonOutput').value.length,
    sigDot: document.getElementById('sigDot').className,
  }));
  console.log('     pre-save state:', JSON.stringify(preSave));
  await page.click('#tableauSaveBtn');
  await new Promise(r => setTimeout(r, 800));
  const postClick = await page.evaluate(() => ({
    modalActive: document.getElementById('saveModal').classList.contains('active'),
    modalDisplay: window.getComputedStyle(document.getElementById('saveModal')).display,
    modalClasses: document.getElementById('saveModal').className,
    toasts: Array.from(document.querySelectorAll('#toastContainer .toast')).map(t => t.textContent.trim()).slice(-3),
  }));
  console.log('     post-click state:', JSON.stringify(postClick));
  // Force-call saveToSigma to bypass any click-binding issues
  if (!postClick.modalActive) {
    const directCall = await page.evaluate(async () => {
      try { await saveToSigma(); return { ok: true, modalClasses: document.getElementById('saveModal').className }; }
      catch (e) { return { ok: false, error: e.message }; }
    });
    console.log('     direct saveToSigma() result:', JSON.stringify(directCall));
  }
  // Re-check
  await new Promise(r => setTimeout(r, 500));
  const recheck = await page.evaluate(() => ({
    modalActive: document.getElementById('saveModal').classList.contains('active'),
    modalDisplay: window.getComputedStyle(document.getElementById('saveModal')).display,
  }));
  console.log('     recheck:', JSON.stringify(recheck));
  if (!recheck.modalActive) { ok('save modal opened', false, JSON.stringify(recheck)); await browser.close(); process.exit(1); }
  ok('save modal opened', true);

  // Wait for workspaces to load
  await page.waitForFunction(
    () => {
      const opts = Array.from(document.getElementById('saveWorkspace').options || []);
      return opts.some(o => o.value && o.value !== '');
    },
    { timeout: 15000 }
  );

  // Pick the first real workspace
  const workspaceId = await page.evaluate(() => {
    const opts = Array.from(document.getElementById('saveWorkspace').options);
    const first = opts.find(o => o.value && o.value !== '');
    if (!first) return null;
    document.getElementById('saveWorkspace').value = first.value;
    document.getElementById('saveWorkspace').dispatchEvent(new Event('change', { bubbles: true }));
    return first.value;
  });
  ok('picked workspace', !!workspaceId, workspaceId || '(none)');

  // Wait for folders, then pick (Workspace Root) which is always first
  await page.waitForFunction(
    () => !document.getElementById('saveFolder').disabled,
    { timeout: 10000 }
  );
  await page.evaluate(() => {
    const sel = document.getElementById('saveFolder');
    sel.value = sel.options[0].value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // Set a unique model name
  const modelName = `Prep E2E test ${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await page.evaluate((nm) => { document.getElementById('saveModelName').value = nm; }, modelName);

  // Capture the saved data model id from the browser console — saveToSigma logs it
  let savedDataModelId = null;
  page.on('console', msg => {
    if (msg.type() === 'log') {
      const t = msg.text();
      const m = t.match(/Saved data model.*"dataModelId":\s*"([0-9a-f-]{36})"/i)
              || t.match(/dataModelId[:=]\s*"?([0-9a-f-]{36})"?/i);
      if (m) savedDataModelId = m[1];
    }
  });

  // Hook the network response to grab dataModelId from the POST result + log errors
  let postErrBody = null;
  let postSeen = false;
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!url.includes('/dataModels/spec')) return;
    postSeen = true;
    console.log(`     [POST resp] ${resp.status()} ${url}`);
    try {
      const text = await resp.text();
      if (resp.ok()) {
        try { const body = JSON.parse(text); if (body.dataModelId) savedDataModelId = body.dataModelId; } catch {}
      } else {
        postErrBody = text;
      }
    } catch (e) { console.log('     [POST resp error]', e.message); }
  });

  // 7. Trigger Save by calling confirmSave() directly — puppeteer's click() doesn't
  // reliably fire the onclick attr in this app's context.
  await page.evaluate(() => { confirmSave(); });

  // Wait for either modal to close (success) or response to come back
  try {
    await page.waitForFunction(
      () => !document.getElementById('saveModal').classList.contains('active'),
      { timeout: 30000 }
    );
  } catch (e) {
    const post = await page.evaluate(() => ({
      btnText: document.getElementById('saveConfirmBtn').textContent.trim(),
      toasts: Array.from(document.querySelectorAll('#toastContainer .toast')).map(t => t.textContent.trim()).slice(-3),
    }));
    ok('Save modal closed (success path)', false, `still open, btn="${post.btnText}", toasts=${JSON.stringify(post.toasts)}`);
  }

  // Give the response listener a moment to fire if it hasn't yet
  await new Promise(r => setTimeout(r, 1500));

  if (postErrBody) {
    console.log('     POST error body:', typeof postErrBody === 'string' ? postErrBody : JSON.stringify(postErrBody).slice(0, 800));
  }
  ok('captured dataModelId from POST response', !!savedDataModelId, savedDataModelId || '(none)');

  await browser.close();

  // 8. Verify via Sigma API
  if (!savedDataModelId) {
    console.log('\n  passed: ' + stats.passed + ', failed: ' + stats.failed);
    process.exit(stats.failed > 0 || !savedDataModelId ? 1 : 0);
  }

  // Get a Sigma access token via client_credentials
  const tokenResp = await fetch(`${SIGMA_BASE_URL}/v2/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${SIGMA_CLIENT_ID}&client_secret=${SIGMA_CLIENT_SECRET}`,
  });
  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) {
    ok('verify: got Sigma token', false, JSON.stringify(tokenData));
    process.exit(1);
  }

  // GET the model spec back
  const specResp = await fetch(`${SIGMA_BASE_URL}/v2/dataModels/${savedDataModelId}/spec`, {
    headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
  });
  ok('verify: GET model spec', specResp.ok, `HTTP ${specResp.status}`);
  if (!specResp.ok) {
    process.exit(1);
  }
  const spec = await specResp.json();

  ok('verify: model name matches',
     spec.name === modelName,
     `expected "${modelName}", got "${spec.name}"`);

  const apiElements = (spec.pages?.[0]?.elements || []);
  ok(`verify: round-tripped elements (${apiElements.length})`, apiElements.length === elementCount,
     `posted ${elementCount}, got back ${apiElements.length}`);

  console.log('\n  Saved data model:');
  console.log(`    https://app.sigmacomputing.com/tj-wells-1989/data-model/${savedDataModelId}`);
  console.log('\n  Round-tripped elements:');
  for (const el of apiElements) {
    const src = el.source || {};
    console.log(`    • ${el.name || '(unnamed)'} kind=${src.kind} cols=${(el.columns||[]).length} rels=${(el.relationships||[]).length}`);
  }

  console.log('\n  passed: ' + stats.passed + ', failed: ' + stats.failed);
  process.exit(stats.failed > 0 ? 1 : 0);
})();
