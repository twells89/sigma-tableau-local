# Tableau → Sigma Converter (Local)

A local Node.js proxy server that connects directly to your Tableau Server, downloads workbooks AND Tableau Prep flows, converts them to Sigma data model JSON, and saves them to Sigma — no manual file export required.

## What is this?

The Tableau → Sigma Converter is a self-contained single-page app (`tableau-local.html`) served by a lightweight Express proxy (`server.js`). The proxy handles CORS by forwarding all Tableau Server REST API calls server-side, so the browser never hits cross-origin restrictions.

**Key capabilities:**

- **Direct Tableau Server integration** — Authenticate with a Personal Access Token (PAT), browse workbooks AND Tableau Prep flows by site, download with one click
- **Workbooks / Flows toggle** — Switch between content types on the connected site
- **File upload** — Drag and drop or browse to upload `.twb` / `.twbx` / `.tds` / `.tdsx` / `.tfl` / `.tflx` files (multiple OK) if you prefer working offline
- **Auto-connect** — Pre-configure server credentials via environment variables; the `⚡ Auto` button fills the form automatically
- **Workbook conversion** — Parses Tableau data sources (standard multi-table joins and the `type=collection` relationship model used by virtual connections)
- **Tableau Prep conversion** — Parses `.tfl`/`.tflx` flows: inputs (LoadSql/LoadCsv/LoadExcel/LoadJson/LoadHyper/LoadGoogle), containers, transforms (AddColumn / RemoveColumns / RenameColumn / Remap / FilterOperation / ChangeColumnType), SuperJoin / SuperUnion / SuperAggregate
- **`LoadSqlProxy` auto-resolver** — When a Prep flow has Tableau Server published-datasource inputs, the converter automatically fetches the matching `.tdsx` from the same Tableau site, extracts the inner `.tds` XML, and replaces the Custom SQL stub with the underlying warehouse table or `SELECT` body — no manual file uploads required
- **Formula conversion** — Converts Tableau calculated field formulas to Sigma equivalents
- **Save to Sigma** — Authenticates to Sigma, lets you pick a workspace/folder, and saves the converted data model via the Sigma REST API
- **Warning surface** — Conversion warnings (unsupported patterns, skipped fields) are shown inline before saving

## Requirements

- Node.js 18+ ([https://nodejs.org](https://nodejs.org))
- A Tableau Server or Tableau Cloud account with API access (Personal Access Token)
- A Sigma workspace with a Client ID and Client Secret

## Setup

```bash
npm install
```

## Run

```bash
# Connect to any Tableau Server:
TABLEAU_SERVER=https://tableau.yourcompany.com node server.js

# Connect to Tableau Cloud (example):
TABLEAU_SERVER=https://10ay.online.tableau.com \
TABLEAU_SITE=mysite \
TABLEAU_PAT_NAME=my-pat \
TABLEAU_PAT_SECRET=xxxxx \
node server.js

# Or use the convenience script (edit start.sh with your credentials):
./start.sh
```

Then open **http://localhost:3333** in your browser.

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | Port to listen on | `3333` |
| `TABLEAU_SERVER` | Tableau Server base URL (no trailing slash) | `http://localhost:80` |
| `TABLEAU_SITE` | Tableau site content URL (blank = Default site) | _(empty)_ |
| `TABLEAU_PAT_NAME` | PAT name for the `⚡ Auto` button | _(empty)_ |
| `TABLEAU_PAT_SECRET` | PAT secret for the `⚡ Auto` button | _(empty)_ |

When `TABLEAU_SERVER`, `TABLEAU_PAT_NAME`, and `TABLEAU_PAT_SECRET` are all set, the `/api/ts-env-config` endpoint returns the credentials to the browser, and the `⚡ Auto` button fills the connection form automatically.

## Usage

### Option A — Connect to Tableau Server/Cloud

1. Click **⚡ Auto** (if credentials are pre-configured) or fill in the connection form manually:
   - **Server URL** — e.g. `https://10ay.online.tableau.com`
   - **Site** — content URL of your site (leave blank for the Default site)
   - **PAT Name / PAT Secret** — your Personal Access Token
2. Click **Connect**.
3. Browse the workbook list and click a workbook name to select it.
4. Click **Load Selected Workbook**.

### Option B — Upload a file

1. Click **Browse** or drag a `.twb` / `.twbx` file onto the upload area.

### Convert and Save

5. Select the **data source** from the dropdown (multi-datasource workbooks list all sources).
6. Select the **Sigma connection** that corresponds to the warehouse the data source points to.
7. Choose a **join strategy** if applicable.
8. Click **Convert to Sigma JSON**.
9. Review the output JSON and any warnings in the panel.
10. In the **Save to Sigma** panel, enter your Sigma Client ID, Client Secret, and region.
11. Click **Connect to Sigma**.
12. Pick a **workspace** and **folder** from the dropdowns (or leave folder blank to save at root).
13. Click **Save to Sigma**.

## What Gets Converted

### Data Sources

| Tableau | Sigma |
|---|---|
| Single-table data source | One `table` element |
| Multi-table joins (star schema) | Fact element with join relationships to dim elements |
| `type=collection` (virtual connection / relationship model) | Full table-per-object element set with relationship graph |
| Custom SQL data source | `customSql` element |

### Columns

| Tableau | Sigma |
|---|---|
| Physical columns (standard TWB) | Columns with `[TableName/Display Name]` formula |
| UUID columns (virtual connection TWB) | Resolved to human-readable captions via `<metadata-record>` elements |
| Calculated fields (simple formula) | Calculated columns with converted formula |
| Calculated fields (aggregate) | Sigma metrics (`Sum`, `Count`, `Avg`, `Min`, `Max`, `CountDistinct`) |
| Parameters | Sigma controls (`list`, `date-range`, `text-input`) |
| Sets | Boolean calculated columns |
| Bins | `Floor()` bucketed calculated columns |
| LOD FIXED expressions | Child elements with explicit grouping |

### Formula Conversion

| Tableau | Sigma |
|---|---|
| `SUM([Field])` | `Sum([Field])` |
| `AVG([Field])` | `Avg([Field])` |
| `COUNTD([Field])` | `CountDistinct([Field])` |
| `IF … THEN … ELSEIF … ELSE … END` | `If(…, …, …)` |
| `IIF(cond, t, f)` | `If(cond, t, f)` |
| `CASE … WHEN … END` | `Switch(…)` |
| `DATEPART('year', …)` | `Year(…)` |
| `DATEPART('month', …)` | `Month(…)` |
| `DATEPART('quarter', …)` | `Quarter(…)` |
| `DATEPART('dayofweek', …)` | `DayOfWeek(…)` |
| `DATETRUNC('month', …)` | `DateTrunc("month", …)` |
| `DATEDIFF('day', a, b)` | `DateDiff("day", a, b)` |
| `DATEADD('month', n, d)` | `DateAdd("month", n, d)` |
| `TODAY()` | `Today()` |
| `NOW()` | `Now()` |
| `LEN([s])` | `Len([s])` |
| `CONTAINS([s], "x")` | `Contains([s], "x")` |
| `LEFT([s], n)` | `Left([s], n)` |
| `RIGHT([s], n)` | `Right([s], n)` |
| `MID([s], n, l)` | `Mid([s], n, l)` |
| `TRIM([s])` | `Trim([s])` |
| `UPPER([s])` | `Upper([s])` |
| `LOWER([s])` | `Lower([s])` |
| `REPLACE([s], a, b)` | `Replace([s], a, b)` |
| `REGEXP_MATCH([s], p)` | `RegexpMatch([s], p)` |
| `ABS([n])` | `Abs([n])` |
| `CEILING([n])` | `Ceiling([n])` |
| `FLOOR([n])` | `Floor([n])` |
| `ROUND([n], d)` | `Round([n], d)` |
| `SQRT([n])` | `Sqrt([n])` |
| `POWER([n], e)` | `Power([n], e)` |
| `LOG([n])` | `Log([n])` |
| `ZN([n])` | `Coalesce([n], 0)` |
| `IFNULL([n], v)` | `Coalesce([n], v)` |
| `ISNULL([n])` | `IsNull([n])` |
| `ISINF([n])` | `IsInf([n])` |
| `MIN([a], [b])` (scalar) | `Min([a], [b])` |
| `MAX([a], [b])` (scalar) | `Max([a], [b])` |
| `STR([n])` | `Text([n])` |
| `INT([n])` | `Int([n])` |
| `FLOAT([n])` | `Number([n])` |
| `RUNNING_SUM([n])` | `CumulativeSum([n])` |
| `RUNNING_COUNT([n])` | `CumulativeCount([n])` |
| `RANK()` | `Rank([n])` |
| `RANK_DENSE()` | `DenseRank([n])` |
| `INDEX()` | `RowNumber()` |

### Known Limitations

- **LOD INCLUDE / EXCLUDE** — Cannot be auto-converted. Generates a warning; recreate using child elements with groupings in the Sigma UI.
- **Complex table calculations** — `LOOKUP`, `PREVIOUS_VALUE`, `WINDOW_SUM`, `WINDOW_AVG` are flagged but not converted.
- **Data blending** — Multi-connection workbooks are not supported; each data source is converted independently.
- **Extracts (`.hyper`)** — Extract-only fields and extract filters are not converted.
- **Top N / Bottom N sets** — Cannot be auto-converted; recreate as filters in the Sigma UI.
- **Custom SQL with Tableau-specific syntax** — Converted to custom SQL elements; syntax that is not valid Snowflake SQL may need manual adjustment.
- **Virtual connection TWBs** — Physical Snowflake column names are replaced by UUIDs in the TWB. The converter reads all `<metadata-record class='column'>` elements in the workbook to resolve UUIDs to human-readable captions. Columns not referenced in the workbook will not appear in the output — visit the virtual connection's datasource in Tableau to verify the full column list.

## Architecture

```
tableau-local/
├── tableau-local.html   # Single-page app (all HTML, CSS, JS)
├── server.js            # Express proxy + /api/ts-env-config endpoint
├── start.sh             # Convenience startup script
├── package.json
└── test/
    └── tool.test.js     # Puppeteer end-to-end tests
```

The proxy forwards `/api/tableau/*` requests to `TABLEAU_SERVER/api/*`, transparently passing headers and bodies. This eliminates CORS issues when calling the Tableau REST API from a browser. The proxy also strips `Content-Encoding` headers from Tableau's responses to avoid double-decoding gzip/deflate bodies.

## Tests

Tests use [Puppeteer](https://pptr.dev/) and require the server to be running:

```bash
# Terminal 1 — start the server (with or without Tableau Cloud credentials)
./start.sh

# Terminal 2 — run the tests
npm test
```

The test suite covers:

| Category | Tests |
|---|---|
| Page & UI | Page title/header, initial button states, status dot, ⚡ Auto button |
| API | `/api/ts-env-config` endpoint shape |
| Formula conversion | `tableauFormulaToSigma()` spot-checks (6 formulas) |
| File upload | Ingest TWB, output JSON validity, stats badges, Copy/Save button states, warning box XSS safety |
| Tableau Cloud | Auto-connect, Superstore workbook load, Superstore conversion |

Tableau Cloud tests are skipped unless `TABLEAU_SERVER` is set to `https://10ay.online.tableau.com` when starting the server.

**TWB fixture** — The file upload tests use `~/Downloads/orders_snowflake.twb`. Those tests are automatically skipped if the file is not present.

## Security Notes

- **PAT secrets** are passed through the server's `/api/ts-env-config` endpoint and held in browser memory only — never written to disk or localStorage.
- **Sigma credentials** (Client ID / Client Secret) are held in browser memory only.
- **TLS verification** — The proxy accepts self-signed certificates from Tableau Server by default (`rejectUnauthorized: false`). Remove this line in `server.js` if your server has a valid CA-signed certificate.
- **Request size limit** — The proxy accepts request bodies up to 50 MB to handle large workbook XML files.

## Sigma API Reference

The tool saves data models via:

```
POST /v2/dataModels/spec
Content-Type: application/json

{
  "schemaVersion": 1,
  "name": "...",
  "pages": [{ "id": "...", "name": "Page 1", "elements": [...] }]
}
```

Region endpoints:

| Region | Base URL |
|---|---|
| US (AWS) | `https://aws-api.sigmacomputing.com` |
| US (GCP) | `https://api.sigmacomputing.com` |
| EU | `https://eu-api.sigmacomputing.com` |
| Canada | `https://ca-api.sigmacomputing.com` |
| UK | `https://uk-api.sigmacomputing.com` |
| AU | `https://au-api.sigmacomputing.com` |
