/**
 * Puppeteer tests for the Tableau → Sigma Converter tool.
 *
 * Requires the server to be running. Start it before running tests:
 *
 *   # Basic (file-upload tests only):
 *   node server.js &
 *
 *   # Full Tableau Cloud flow (uses MCP credentials):
 *   TABLEAU_SERVER=https://10ay.online.tableau.com \
 *   TABLEAU_SITE=dataflow \
 *   TABLEAU_PAT_NAME=Sigma-MCP-Test \
 *   TABLEAU_PAT_SECRET="your-pat-secret-here" \
 *   node server.js &
 *
 *   node test/tool.test.js
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');

const BASE_URL      = 'http://localhost:3333';
const TWB_FIXTURE   = path.join(__dirname, '../../..', 'Downloads/orders_snowflake.twb');
const TABLEAU_CLOUD = process.env.TABLEAU_SERVER === 'https://10ay.online.tableau.com';

let browser, page;
const results = { passed: 0, failed: 0, skipped: 0 };

// ── Helpers ────────────────────────────────────────────────────────────────

async function setup() {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    page    = await browser.newPage();
    page.on('console', msg => {
        if (msg.type() === 'error') process.stdout.write(`  [browser error] ${msg.text()}\n`);
    });
    await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 15000 });
}

async function teardown() {
    await browser.close();
}

async function run(name, fn, skip = false) {
    if (skip) {
        console.log(`  ⊙ SKIP  ${name}`);
        results.skipped++;
        return;
    }
    try {
        await fn();
        console.log(`  ✓ PASS  ${name}`);
        results.passed++;
    } catch(e) {
        console.log(`  ✗ FAIL  ${name}`);
        console.log(`         ${e.message.split('\n')[0]}`);
        results.failed++;
    }
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg || 'Assertion failed');
}

// ── Tests ──────────────────────────────────────────────────────────────────

async function testPageLoads() {
    const title = await page.title();
    assert(title.includes('Tableau') && title.includes('Sigma'), `Unexpected title: "${title}"`);

    const header = await page.$eval('.header-title', el => el.textContent.trim());
    assert(header === 'Tableau → Sigma Converter', `Unexpected header: "${header}"`);
}

async function testInitialButtonStates() {
    const convertDisabled = await page.$eval('#tableauConvertBtn', el => el.disabled);
    assert(convertDisabled, 'Convert button should be disabled before loading a workbook');

    const saveDisabled = await page.$eval('#tableauSaveBtn', el => el.disabled);
    assert(saveDisabled, 'Save button should be disabled before converting');

    const copyDisabled = await page.$eval('#tableauCopyBtn', el => el.disabled);
    assert(copyDisabled, 'Copy button should be disabled before converting');
}

async function testTsStatusDotStartsGrey() {
    const dotClass = await page.$eval('#tsDot', el => el.className);
    assert(dotClass === 'dot', `Expected plain dot class, got: "${dotClass}"`);

    const statusText = await page.$eval('#tsStatus', el => el.textContent.trim());
    assert(statusText === 'Not connected', `Expected "Not connected", got: "${statusText}"`);
}

async function testAutoConnectButtonExists() {
    const btn = await page.$('#tsEnvBtn');
    assert(btn !== null, 'Auto-connect button #tsEnvBtn not found');

    const text = await page.$eval('#tsEnvBtn', el => el.textContent.trim());
    assert(text === '⚡ Auto', `Unexpected button text: "${text}"`);
}

async function testEnvConfigEndpoint() {
    const resp = await page.evaluate(async () => {
        const r = await fetch('/api/ts-env-config');
        return r.json();
    });
    // Just verify the endpoint returns a valid shape
    assert(typeof resp.available === 'boolean', 'Missing "available" field in /api/ts-env-config response');
    return resp;
}

async function testFileUploadAndConversion() {
    if (!fs.existsSync(TWB_FIXTURE)) {
        throw new Error(`TWB fixture not found: ${TWB_FIXTURE}`);
    }
    const twbContent = fs.readFileSync(TWB_FIXTURE, 'utf8');

    // Inject the TWB XML directly via the ingestTableauXml function (bypasses file picker)
    await page.evaluate((xml) => {
        window.ingestTableauXml(xml, 'orders_snowflake.twb');
    }, twbContent);

    // Convert button should now be enabled
    await page.waitForFunction(() => !document.getElementById('tableauConvertBtn').disabled, { timeout: 3000 });

    // Pick a placeholder connection ID and run conversion
    await page.select('#tableauConnectionId', await page.$eval('#tableauConnectionId', el => el.options[0]?.value || ''));
    await page.click('#tableauConvertBtn');

    // Wait for output to appear
    await page.waitForFunction(
        () => document.getElementById('tableauJsonOutput').value.length > 10,
        { timeout: 5000 }
    );

    const jsonText = await page.$eval('#tableauJsonOutput', el => el.value);
    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    } catch(e) {
        throw new Error(`Output is not valid JSON: ${jsonText.slice(0, 200)}`);
    }

    assert(parsed.name, 'Converted JSON missing "name" field');
    assert(Array.isArray(parsed.pages), 'Converted JSON missing "pages" array');
    assert(parsed.pages.length > 0, '"pages" array is empty');
    assert(Array.isArray(parsed.pages[0].elements), 'First page missing "elements" array');
    assert(parsed.pages[0].elements.length > 0, '"elements" array is empty');

    // Verify at least one element has a source with connectionId or elementId
    const hasSource = parsed.pages[0].elements.some(e => e.source);
    assert(hasSource, 'No elements have a "source" field');

    return parsed;
}

async function testOutputStatsUpdate() {
    const badges = await page.$eval('#tableauOutputStats', el => el.textContent.trim());
    assert(badges.length > 0, 'Output stats badges not populated after conversion');
    assert(badges.includes('element'), `Expected "element" in stats, got: "${badges}"`);
}

async function testCopyButtonEnabledAfterConversion() {
    const copyDisabled = await page.$eval('#tableauCopyBtn', el => el.disabled);
    assert(!copyDisabled, 'Copy button should be enabled after conversion');
}

async function testSaveButtonEnabledAfterConversion() {
    const saveDisabled = await page.$eval('#tableauSaveBtn', el => el.disabled);
    assert(!saveDisabled, 'Save button should be enabled after conversion');
}

async function testWarningBoxRendersHtml() {
    const warnVisible = await page.$eval('#tableauWarningBox', el => el.style.display !== 'none');
    if (warnVisible) {
        const warnHtml = await page.$eval('#tableauWarningBox', el => el.innerHTML);
        assert(!warnHtml.includes('<script'), 'Warning box contains unescaped script tag — XSS risk');
        assert(warnHtml.includes('<div>'), 'Warning box content not wrapped in divs');
    }
}

async function testFormulaConversion() {
    // Run formula conversion logic in the page context
    const cases = await page.evaluate(() => {
        const w = [];
        return [
            { input: 'SUM([Sales])',             expected: 'Sum([Sales])' },
            { input: 'IF [Profit] > 0 THEN "Profitable" ELSE "Loss" END',
              expected: 'If([Profit] > 0, "Profitable", "Loss")' },
            { input: 'DATEPART(\'year\', [Order Date])',
              expected: 'Year([Order Date])' },
            { input: 'ZN([Sales])',               expected: 'Coalesce([Sales], 0)' },
            { input: 'COUNTD([Customer ID])',     expected: 'CountDistinct([Customer ID])' },
            { input: "ISNULL([Region])",          expected: 'IsNull([Region])' },
        ].map(c => ({
            input:    c.input,
            expected: c.expected,
            actual:   window.tableauFormulaToSigma(c.input, w)
        }));
    });

    for (const c of cases) {
        assert(
            c.actual === c.expected,
            `tableauFormulaToSigma("${c.input}")\n  expected: ${c.expected}\n  actual:   ${c.actual}`
        );
    }
}

async function testTableauCloudAutoConnect() {
    // Click ⚡ Auto and verify the form fills + workbook list appears
    await page.click('#tsEnvBtn');

    // Wait for workbook list section to appear
    await page.waitForFunction(
        () => document.getElementById('tsWorkbookSection').style.display !== 'none',
        { timeout: 20000 }
    );

    const dotClass = await page.$eval('#tsDot', el => el.className);
    assert(dotClass.includes('connected'), `Expected connected dot, got: "${dotClass}"`);

    // Verify we got workbooks
    const wbCount = await page.$$eval('#tsWorkbookList .wb-item', els => els.length);
    assert(wbCount > 0, `Expected workbooks to load, got ${wbCount}`);

    // Superstore should be in the list
    const names = await page.$$eval('#tsWorkbookList .wb-name', els => els.map(e => e.textContent.trim()));
    assert(names.includes('Superstore'), `Expected "Superstore" in workbook list, got: ${names.join(', ')}`);
}

async function testTableauCloudLoadWorkbook() {
    // Click Superstore
    // evaluateHandle returns an ElementHandle or a null JSHandle — coerce via asElement()
    const superstoreHandle = await page.evaluateHandle(() => {
        const items = Array.from(document.querySelectorAll('#tsWorkbookList .wb-item'));
        return items.find(i => i.querySelector('.wb-name')?.textContent.trim() === 'Superstore') || null;
    });
    const superstoreItem = superstoreHandle.asElement();
    assert(superstoreItem !== null, '"Superstore" workbook item not found in list');
    await superstoreItem.click();

    const loadDisabled = await page.$eval('#tsLoadBtn', el => el.disabled);
    assert(!loadDisabled, 'Load button should be enabled after selecting a workbook');

    await page.click('#tsLoadBtn');

    // Wait for conversion button to enable (workbook loaded)
    await page.waitForFunction(
        () => !document.getElementById('tableauConvertBtn').disabled,
        { timeout: 30000 }
    );

    const statsText = await page.$eval('#tableauInputStats', el => el.textContent.trim());
    assert(statsText.length > 0, 'Input stats should be populated after loading workbook');
}

async function testTableauCloudConvertSuperstore() {
    await page.click('#tableauConvertBtn');

    await page.waitForFunction(
        () => document.getElementById('tableauJsonOutput').value.length > 50,
        { timeout: 10000 }
    );

    const jsonText = await page.$eval('#tableauJsonOutput', el => el.value);
    const parsed   = JSON.parse(jsonText);

    assert(parsed.name, 'Missing name in Superstore output');
    assert(parsed.pages[0].elements.length > 0, 'Superstore conversion produced no elements');

    // Superstore has a known datasource with multiple tables/joins — expect a reasonable element count
    const elementCount = parsed.pages[0].elements.filter(e => e.kind === 'table').length;
    assert(elementCount >= 1, `Expected at least 1 table element, got ${elementCount}`);
}

// ── Main ───────────────────────────────────────────────────────────────────

(async () => {
    console.log('\nTableau → Sigma Converter — Puppeteer Tests');
    console.log('============================================\n');

    console.log(`Server:        ${BASE_URL}`);
    console.log(`TWB fixture:   ${fs.existsSync(TWB_FIXTURE) ? TWB_FIXTURE : '(not found)'}`);
    console.log(`Tableau Cloud: ${TABLEAU_CLOUD ? 'YES — will run live connection tests' : 'NO — skipping live tests'}`);
    console.log('');

    try {
        await setup();
    } catch(e) {
        console.error(`\n  FATAL: could not connect to ${BASE_URL} — is the server running?\n  ${e.message}\n`);
        process.exit(1);
    }

    // ── Always-run tests ─────────────────────────────────────────────
    console.log('Page & UI');
    await run('page title and header',               testPageLoads);
    await run('initial button states (all disabled)', testInitialButtonStates);
    await run('Tableau status dot starts grey',       testTsStatusDotStartsGrey);
    await run('⚡ Auto button present',               testAutoConnectButtonExists);
    await run('/api/ts-env-config returns valid shape', testEnvConfigEndpoint);

    console.log('\nFormula conversion');
    await run('tableauFormulaToSigma() spot-checks',  testFormulaConversion);

    console.log('\nFile upload + conversion (orders_snowflake.twb)');
    const hasTwb = fs.existsSync(TWB_FIXTURE);
    await run('ingest TWB and run conversion',         testFileUploadAndConversion, !hasTwb);
    await run('output stats badges update',           testOutputStatsUpdate,       !hasTwb);
    await run('Copy button enabled after conversion', testCopyButtonEnabledAfterConversion, !hasTwb);
    await run('Save button enabled after conversion', testSaveButtonEnabledAfterConversion, !hasTwb);
    await run('warning box content is HTML-escaped',  testWarningBoxRendersHtml,   !hasTwb);

    // ── Tableau Cloud tests (only when server has credentials) ───────
    console.log('\nTableau Cloud — live connection (10ay.online.tableau.com)');
    if (TABLEAU_CLOUD) {
        // Fresh page for the cloud tests so state is clean
        await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 15000 });
    }
    await run('⚡ Auto-connect fills form and loads workbooks', testTableauCloudAutoConnect, !TABLEAU_CLOUD);
    await run('select and download Superstore workbook',        testTableauCloudLoadWorkbook, !TABLEAU_CLOUD);
    await run('convert Superstore → valid Sigma JSON',          testTableauCloudConvertSuperstore, !TABLEAU_CLOUD);

    await teardown();

    console.log(`\n────────────────────────────────────────`);
    console.log(`  Passed:  ${results.passed}`);
    console.log(`  Failed:  ${results.failed}`);
    console.log(`  Skipped: ${results.skipped}`);
    console.log('');

    process.exit(results.failed > 0 ? 1 : 0);
})();
