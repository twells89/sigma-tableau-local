/**
 * Sigma Tableau Local — Proxy Server
 *
 * Serves tableau-local.html and proxies Tableau Server REST API calls,
 * eliminating CORS issues when talking to an on-prem Tableau Server.
 *
 * Usage:
 *   npm install
 *   node server.js
 *
 * Then open http://localhost:3333 in your browser.
 *
 * Set TABLEAU_SERVER env var to point at your server (default http://localhost:80):
 *   TABLEAU_SERVER=https://tableau.mycompany.com node server.js
 */

const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const https   = require('https');
const http    = require('http');

const app  = express();
const PORT = process.env.PORT || 3333;

// The Tableau Server base URL — no trailing slash.
// Override via environment variable: TABLEAU_SERVER=https://tableau.company.com
const TABLEAU_SERVER = (process.env.TABLEAU_SERVER || 'http://localhost:80').replace(/\/$/, '');

// Allow large request bodies (workbook XML can be several MB)
app.use(express.json({ limit: '50mb' }));
app.use(express.text({ type: '*/*', limit: '50mb' }));
app.use(express.raw({ type: '*/*', limit: '50mb' }));

// Serve the HTML file at root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'tableau-local.html'));
});

// ── Tableau Server proxy ───────────────────────────────────────────────────
// All requests to /api/tableau/* are forwarded to TABLEAU_SERVER/api/*
app.all('/api/tableau/*', async (req, res) => {
    // Strip the /api/tableau prefix and forward as /api/...
    const targetPath = req.path.replace(/^\/api\/tableau/, '/api');
    const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const targetUrl = TABLEAU_SERVER + targetPath + queryString;

    // Forward all headers except host (and some hop-by-hop headers)
    const skipHeaders = new Set(['host', 'connection', 'transfer-encoding', 'keep-alive',
        'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'upgrade']);
    const forwardHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
        if (!skipHeaders.has(k.toLowerCase())) forwardHeaders[k] = v;
    }

    // Build fetch options
    const fetchOptions = {
        method:  req.method,
        headers: forwardHeaders,
    };

    // Forward body for non-GET/HEAD requests
    if (!['GET', 'HEAD'].includes(req.method.toUpperCase())) {
        if (Buffer.isBuffer(req.body)) {
            fetchOptions.body = req.body;
        } else if (typeof req.body === 'string') {
            fetchOptions.body = req.body;
        } else if (req.body && typeof req.body === 'object') {
            fetchOptions.body = JSON.stringify(req.body);
        }
    }

    // Disable TLS verification for self-signed certs on internal Tableau servers
    // Remove this if your server has a valid certificate
    if (targetUrl.startsWith('https://')) {
        fetchOptions.agent = new https.Agent({ rejectUnauthorized: false });
    }

    try {
        const upstream = await fetch(targetUrl, fetchOptions);

        // Copy status + safe response headers
        res.status(upstream.status);
        // node-fetch decodes gzip/deflate automatically, so strip Content-Encoding
        // to avoid the browser double-decoding an already-decoded body.
        const skipRespHeaders = new Set(['transfer-encoding', 'connection', 'keep-alive', 'content-encoding']);
        for (const [k, v] of upstream.headers) {
            if (!skipRespHeaders.has(k.toLowerCase())) res.setHeader(k, v);
        }

        // Stream body back
        const body = await upstream.buffer();
        res.send(body);

    } catch (err) {
        console.error('[proxy error]', err.message, '→', targetUrl);
        res.status(502).json({ error: 'Proxy error', message: err.message, target: targetUrl });
    }
});

// ── Tableau env-config endpoint ────────────────────────────────────────────
// Returns pre-configured Tableau Cloud connection details from environment
// variables so the browser can auto-fill the connection form.
// Set: TABLEAU_SERVER, TABLEAU_SITE, TABLEAU_PAT_NAME, TABLEAU_PAT_SECRET
app.get('/api/ts-env-config', (req, res) => {
    const serverUrl = process.env.TABLEAU_SERVER || '';
    const site      = process.env.TABLEAU_SITE      || '';
    const patName   = process.env.TABLEAU_PAT_NAME   || '';
    const patSecret = process.env.TABLEAU_PAT_SECRET || '';
    if (!serverUrl || !patName || !patSecret) {
        return res.json({ available: false });
    }
    res.json({ available: true, serverUrl, site, patName, patSecret });
});

app.listen(PORT, () => {
    console.log(`\n  Sigma Tableau Local`);
    console.log(`  ────────────────────────────────────────`);
    console.log(`  App:             http://localhost:${PORT}`);
    console.log(`  Tableau Server:  ${TABLEAU_SERVER}`);
    console.log(`\n  To use a different Tableau Server:`);
    console.log(`    TABLEAU_SERVER=https://tableau.company.com node server.js`);
    console.log(``);
});
