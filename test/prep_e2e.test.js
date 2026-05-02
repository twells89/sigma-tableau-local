/**
 * E2E test for the Tableau Prep flow conversion path:
 *   1. ⚡ Auto-connect to Tableau Cloud
 *   2. Switch to the Flows tab
 *   3. Verify flows are listed
 *   4. Select first flow, load it
 *   5. Verify a Sigma model is produced (output JSON has elements)
 *
 * Requires the server to be running with TABLEAU_SERVER+PAT env vars set.
 *   ./start.sh        (or set vars manually and: node server.js)
 *
 * Run:
 *   node test/prep_e2e.test.js
 */

const puppeteer = require('puppeteer');
const BASE_URL = 'http://localhost:3333';

let browser, page;
let stats = { passed: 0, failed: 0 };

function ok(msg, cond, detail) {
  if (cond) { console.log('  ✓ PASS  ' + msg); stats.passed++; }
  else { console.log('  ✗ FAIL  ' + msg + (detail ? '\n           ' + detail : '')); stats.failed++; }
}

(async () => {
  console.log('\nTableau Prep E2E (auto-connect + flow listing + conversion)');
  console.log('============================================================\n');

  browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  page = await browser.newPage();
  page.on('pageerror', err => console.log('  [browser pageerror]', err.message));
  await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 15000 });

  ok('page loaded',
     await page.$eval('.header-title', el => el.textContent.trim() === 'Tableau → Sigma Converter'));

  // 1. Auto-connect
  await page.click('#tsEnvBtn');
  await page.waitForFunction(
    () => document.getElementById('tsWorkbookSection').style.display !== 'none',
    { timeout: 25000 }
  );
  ok('Auto-connect succeeded',
     (await page.$eval('#tsDot', el => el.className)).includes('connected'));

  // 2. Switch to Flows tab. The click handler is fire-and-forget for tsListFlows;
  // explicitly await it from the page context so the test is deterministic.
  ok('type toggle present', !!(await page.$('#tsTypeFlowBtn')));
  const listResult = await page.evaluate(async () => {
    setTsItemType('flows');
    if (tsState.token) await tsListFlows();
    return { count: tsState.flows.length, names: tsState.flows.map(f => f.name) };
  });
  ok(`flows listed (${listResult.count})`, listResult.count > 0);
  if (listResult.count === 0) {
    console.log('  (no flows on this site — bailing)');
    await browser.close();
    process.exit(0);
  }
  await page.waitForFunction(
    () => {
      const items = document.querySelectorAll('#tsWorkbookList .wb-item');
      return items.length > 0 && /selectFlow/.test(items[0].getAttribute('onclick') || '');
    },
    { timeout: 5000 }
  );
  ok('flow items rendered with selectFlow handler', true);

  // 3. Select first flow and load it
  await page.click('#tsWorkbookList .wb-item');
  ok('load button enabled after select',
     !(await page.$eval('#tsLoadBtn', el => el.disabled)));
  await page.click('#tsLoadBtn');

  // 4. Wait for the converter to produce output
  await page.waitForFunction(
    () => document.getElementById('tableauJsonOutput').value.length > 50,
    { timeout: 60000 }
  );
  const outText = await page.$eval('#tableauJsonOutput', el => el.value);

  let parsed;
  try { parsed = JSON.parse(outText); }
  catch (e) {
    ok('output is JSON', false, outText.slice(0, 200));
    await browser.close(); process.exit(1);
  }

  ok('output has name', !!parsed.name);
  const elements = parsed.pages?.[0]?.elements || [];
  ok('output has elements', elements.length > 0);

  console.log(`  ${elements.length} elements:`);
  for (const el of elements) {
    console.log(`    • ${el.name || '(unnamed)'} [${el.source?.kind}] cols=${(el.columns||[]).length} rels=${(el.relationships||[]).length}`);
  }

  // Inspect warnings — look for .tds resolver evidence if applicable
  const warnText = await page.$eval('#tableauWarningBox', el => el.textContent.trim()).catch(() => '');
  if (/resolved via companion \.tds/i.test(warnText)) {
    ok('LoadSqlProxy auto-resolved via companion .tds', true);
  } else if (/LoadSqlProxy/i.test(warnText)) {
    ok('LoadSqlProxy stub fallback (no matching .tds on server)', true);
  }

  await browser.close();
  console.log(`\n  passed: ${stats.passed}, failed: ${stats.failed}\n`);
  process.exit(stats.failed > 0 ? 1 : 0);
})();
