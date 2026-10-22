# SurveyMonkey → Power BI Connector

[![CI](https://github.com/Harsha99-99/surveymonkey-powerbi-connector/actions/workflows/ci.yml/badge.svg)](https://github.com/Harsha99-99/surveymonkey-powerbi-connector/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Harsha99-99/surveymonkey-powerbi-connector)](https://github.com/Harsha99-99/surveymonkey-powerbi-connector/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Connect your SurveyMonkey surveys to Power BI without writing code.

This is a self-hosted Azure Function that authenticates to SurveyMonkey,
pulls your survey responses, reshapes the nested JSON into analytics-ready
tables, and serves them over HTTPS for Power BI to consume on scheduled
refresh. You deploy it into your own Azure subscription, so your survey data
and credentials never leave your infrastructure.

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FHarsha99-99%2Fsurveymonkey-powerbi-connector%2Fmaster%2Fazuredeploy.json)

**Windows app:** [download SurveyMonkey-PowerBI-Setup.exe](https://github.com/Harsha99-99/surveymonkey-powerbi-connector/releases/latest/download/SurveyMonkey-PowerBI-Setup.exe) to set the connector up on a PC without typing commands. See [Windows setup app](#windows-setup-app-no-terminal-needed).

> **Status: early development, but usable end to end.** Deploy with the button
> above, finish setup in the built-in browser wizard, and connect Power BI.
> Remaining work is polish and a tagged release — see
> [`docs/ROADMAP.md`](docs/ROADMAP.md). Contributions welcome.

## Why this exists

Power BI has no native SurveyMonkey connector. The usual workarounds are
manual CSV exports (which don't refresh) or bespoke scripts (which every team
rebuilds from scratch). This project aims to be the reusable piece in the
middle: point it at your SurveyMonkey account, point Power BI at it, and let
scheduled refresh handle the rest.

## What you get

- **A model, not a blob of JSON.** Five related tables (`surveys`,
  `questions`, `choices`, `responses`, `answers`) that Power BI can build
  relationships across. A single flat table is also produced if you'd rather
  not model anything.
- **Numbers that behave like numbers.** Rating scales and weighted choices
  carry their numeric value, so you can average a satisfaction score without
  building a lookup table by hand in Power Query.
- **Matrix and "Other" questions handled properly.** Matrix rows get their own
  columns instead of being mashed into one string, and "Other (please
  specify)" keeps both the choice and the text the respondent typed.
- **Scheduled sync, so refreshes are fast and safe.** Data is pulled from
  SurveyMonkey on your schedule and written to your own Blob Storage. Power BI
  reads the stored files, which means refresh frequency in Power BI has no
  effect on SurveyMonkey API usage — and a SurveyMonkey outage doesn't empty
  your report.
- **Optional history.** Turn on snapshots and each sync freezes a dated copy,
  which is what makes quarter-over-quarter analysis possible — SurveyMonkey
  itself only ever tells you the current state.
- **Skipped questions stay visible.** A skipped question emits a flagged row
  rather than vanishing, so completion rates stay honest. A question added to
  the survey after a response was collected emits nothing for it.
- **Credentials in Key Vault.** The Function reads its SurveyMonkey token via
  Managed Identity — no secrets in code, config files, or environment
  variables. Respondent identifiers are stripped before anything is stored.
- **Logging that can't leak survey content.** The logger uses a strict
  allowlist: IDs, counts, timings, and status codes only. Question text and
  answer values are never written to logs.

## How it works

```
        timer (default: every 6 hours)
                 |
                 v
        Azure Function
          - reads the SurveyMonkey token from Key Vault
          - pulls survey structure + responses (incrementally)
          - builds the tables, writes CSV
                 |
                 v
        Blob Storage (your storage account)
                 |
                 v  HTTPS, function key
        Power BI scheduled refresh
```

See [`docs/architecture.md`](docs/architecture.md) for the detailed design and
the reasoning behind it.

## Prerequisites

- An **Azure subscription** (the Function runs in your tenant)
- **Node.js 20 or 22** (22 recommended — Node 18 is end-of-life, and Node 20
  entered maintenance)
- [**Azure Functions Core Tools v4**](https://learn.microsoft.com/azure/azure-functions/functions-run-local),
  installed globally — it's needed to run the Function locally (`npm start`),
  but not to run the tests:
  ```bash
  npm install -g azure-functions-core-tools@4 --unsafe-perm true
  # macOS:   brew tap azure/functions && brew install azure-functions-core-tools@4
  # Windows: winget install Microsoft.Azure.FunctionsCoreTools
  ```
- **Azure CLI**, logged in via `az login` (local development uses your
  identity to reach Key Vault)
- A **SurveyMonkey Developer App** with an access token — create one at
  [developer.surveymonkey.com](https://developer.surveymonkey.com/apps/).
  The token needs the `surveys_read` and `responses_read` scopes.

## Quickstart (local)

Run the connector on your own machine before you deploy it. There are two ways to do this:

- **No Azure resources (recommended for testing).** Your SurveyMonkey token goes in a local settings file, and synced data is written to a local storage emulator (Azurite). You need no Azure subscription.
- **With Azure Key Vault.** Your token is read from a real Key Vault using your `az login` identity. Use this to test the same path a deployed Function takes.

The steps below use the no-Azure path. Key Vault setup is at the end of this section.

Before you start, make sure you have everything from [Prerequisites](#prerequisites). Run `node --version` and `func --version` to confirm.

### Windows setup app (no terminal needed)

If you would rather not type commands, download **[SurveyMonkey-PowerBI-Setup.exe](https://github.com/Harsha99-99/surveymonkey-powerbi-connector/releases/latest/download/SurveyMonkey-PowerBI-Setup.exe)** and run it. It walks through the Windows steps below with one button per step, and shows each command and its output as it runs. The result is the same as typing the commands yourself.

- It installs for your user account only. Installing Node.js, the Functions tools or Git may still ask Windows for permission.
- The installer is not code-signed yet, so Windows may say "Windows protected your PC". Choose **More info**, then **Run anyway**.
- Closing the app stops the storage emulator and the connector, unless you turn on **keep running** (see below).

After setup, the app has three more screens:

- **Data and CSV files:** sync each survey, and save every table as CSV files into a folder you choose, by hand or automatically after every sync. It runs the same `npm run export` command described in [Save tables as CSV files](#save-tables-as-csv-files), and its **Update the connector** button runs the commands in [Update to the latest version](#update-to-the-latest-version).
- **Power BI:** pick a survey, the latest data or a dated snapshot, CSV or JSON, and the tables you want. Preview each table, then copy its URL and a ready-made Power Query that sets the column types. It also lists the relationships and measures from [docs/powerbi.md](docs/powerbi.md).
- **Scheduled refresh:** a step-by-step guide for refreshing in the Power BI service from this PC through Microsoft's on-premises data gateway (personal mode), with suggested refresh times based on the connector's sync schedule. In the installed app you can turn on **keep running**, which starts the connector with Windows and keeps it running from an icon by the clock. A section covers refreshing from Azure, later.

### Windows (PowerShell)

Run these in PowerShell. Use `curl.exe` rather than `curl`, because in PowerShell `curl` is an alias for a different command.

**0. Install the tools** (anything already installed is skipped)

```powershell
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
winget install --id Microsoft.Azure.FunctionsCoreTools -e --accept-source-agreements --accept-package-agreements
winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
```

Close and reopen PowerShell afterwards, so it finds the new tools.

**1. Get the code and install dependencies**

```powershell
git clone https://github.com/Harsha99-99/surveymonkey-powerbi-connector.git
cd surveymonkey-powerbi-connector
npm ci
```

**2. Create your local settings file**

```powershell
Copy-Item local.settings.json.example local.settings.json
```

Open `local.settings.json` and set these values under `Values`:

| Setting | Value |
|---|---|
| `SECRETS_BACKEND` | `local-override` |
| `SM_ACCESS_TOKEN_SECRET_NAME` | `surveymonkey-access-token` (leave as is) |
| `SM_ACCESS_TOKEN_LOCAL_OVERRIDE` | your SurveyMonkey access token |
| `KEY_VAULT_URI` | empty |
| `STORAGE_ACCOUNT_URL` | empty (if set, it takes precedence over the emulator) |
| `STORAGE_CONNECTION_STRING` | `UseDevelopmentStorage=true` |
| `SYNC_SURVEY_IDS` | comma-separated survey IDs to sync. Empty syncs every survey the token can see. |

> **Warning:** `local.settings.json` is git-ignored. Never commit it, and never put a real token in `local.settings.json.example`.

**3. Start the storage emulator** (terminal 1, leave it running)

```powershell
npm run azurite
```

**4. Start the Function** (terminal 2, leave it running)

```powershell
npm start
```

Wait until the console lists the function routes before you send requests.

**5. Check it works** (terminal 3)

```powershell
curl.exe http://localhost:7071/api/health
curl.exe http://localhost:7071/api/setup/status
curl.exe http://localhost:7071/api/surveys
```

**6. Sync a survey and read it back**

```powershell
curl.exe -X POST http://localhost:7071/api/sync/<survey-id>
curl.exe http://localhost:7071/api/surveys/<survey-id>/status
curl.exe "http://localhost:7071/api/surveys/<survey-id>/data/answers"
```

Before the first sync, the `data/answers` request returns `404 not_synced`. That's expected.

**7. Optional: open the setup wizard**

Open `http://localhost:7071/api/ui#power-bi` in your browser. If you synced a survey in step 6, it opens straight at **Connect Power BI**, so you can skip the wizard's earlier steps. Otherwise it starts at the beginning. The wizard is also how you manage the connector later, from any browser: change which surveys sync, turn on history, or run a sync.

### macOS and Linux

**1. Get the code and install dependencies**

```bash
git clone https://github.com/Harsha99-99/surveymonkey-powerbi-connector.git
cd surveymonkey-powerbi-connector
npm ci
```

**2. Create your local settings file**

```bash
cp local.settings.json.example local.settings.json
```

Open `local.settings.json` and set the same values as in the Windows table above.

> **Warning:** `local.settings.json` is git-ignored. Never commit it, and never put a real token in `local.settings.json.example`.

**3. Start the storage emulator** (terminal 1, leave it running)

```bash
npm run azurite
```

**4. Start the Function** (terminal 2, leave it running)

```bash
npm start
```

Wait until the console lists the function routes before you send requests.

**5. Check it works** (terminal 3)

```bash
curl http://localhost:7071/api/health
curl http://localhost:7071/api/setup/status
curl http://localhost:7071/api/surveys
```

**6. Sync a survey and read it back**

```bash
curl -X POST http://localhost:7071/api/sync/<survey-id>
curl http://localhost:7071/api/surveys/<survey-id>/status
curl "http://localhost:7071/api/surveys/<survey-id>/data/answers"
```

Before the first sync, the `data/answers` request returns `404 not_synced`. That's expected.

**7. Optional: open the setup wizard**

Open `http://localhost:7071/api/ui#power-bi` in your browser. If you synced a survey in step 6, it opens straight at **Connect Power BI**, so you can skip the wizard's earlier steps. Otherwise it starts at the beginning. The wizard is also how you manage the connector later, from any browser: change which surveys sync, turn on history, or run a sync.

### Save tables as CSV files

Once a survey has synced, you can save its tables as ordinary CSV files, to open in Excel or to read with Power BI's Folder connector. With the connector running:

**Windows (PowerShell)**

```powershell
npm run export -- --survey <survey-id> --out "<folder>"
```

**macOS and Linux**

```bash
npm run export -- --survey <survey-id> --out "<folder>"
```

Replace `<folder>` with where the files should go, such as `C:\Users\you\Documents\SurveyMonkey data`. For several surveys, separate the IDs with commas.

- Each survey gets its own `survey-<id>` folder, with one CSV per table and an `about.txt` naming the survey and when it last synced.
- Every export replaces the previous files. If one is open in Excel, the export stops and says which file to close.
- Add `--snapshot 2026-10-22` to save a dated snapshot instead, into `survey-<id>\snapshot-2026-10-22`.
- The Windows setup app can do this for you after every sync, into a folder you choose.

### Update to the latest version

To pick up a newer version of the connector later, run these in the connector folder, then restart `npm start`.

**Windows (PowerShell)**

```powershell
git restore package-lock.json
git pull --ff-only
npm ci
```

**macOS and Linux**

```bash
git restore package-lock.json
git pull --ff-only
npm ci
```

`git restore package-lock.json` undoes the changes an older `npm install` may have made to that file, which would otherwise stop `git pull`. Your `local.settings.json` and synced data aren't touched. The Windows setup app does the same with its **Update the connector** button.

### Running the tests locally

The offline tests need no setup. The integration tests need Azurite running.

**Offline unit tests** (any platform):

```bash
npm test
```

**Integration tests against Azurite** (any platform, with `npm run azurite` running in another terminal):

```bash
npm run test:integration
```

The integration suite should report 0 skipped. If it reports skipped tests, the storage emulator isn't running or `STORAGE_CONNECTION_STRING` isn't set.

**Windows setup app tests** (any platform, no install needed):

```bash
node scripts/runTests.js --dir desktop/test
```

Tests cover the transformation logic using fixture JSON — no network calls and
no Azure dependency, so they run anywhere. The transform is the part most
likely to need adjustment as real survey data reveals edge cases, so it has
the tightest coverage.

### Troubleshooting

- **The Windows setup app opens to an empty window for a while.** On some PCs, security software checks each new app process before it runs, so the first screen can take 10 to 30 seconds to appear. The title bar says "Starting…" until it does.
- **`npm` is blocked by "running scripts is disabled" on Windows.** Use `npm.cmd` in place of `npm`, for example `npm.cmd install`, or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
- **`/api/surveys/<id>/data/...` returns 404 `not_synced`.** Run the sync step (step 6) first.
- **`/api/surveys` returns 502 `surveymonkey_token_invalid`.** The token in `SM_ACCESS_TOKEN_LOCAL_OVERRIDE` is wrong or has been revoked. Create a new token in the SurveyMonkey developer portal and update the setting, then restart `npm start`.
- **Power BI Desktop shows "unable to retrieve the contents of the web page."** Use the Blank query method with `Web.Contents` shown in [docs/powerbi.md](docs/powerbi.md). The plain "Web page" connector expects HTML, not CSV.

### Using Azure Key Vault instead

Use this path to test the same secret handling a deployed Function uses. You need an Azure subscription and `az login`.

Copy the settings file and set `KEY_VAULT_URI` to your vault:

```bash
cp local.settings.json.example local.settings.json
```

On Windows PowerShell, use `Copy-Item` instead of `cp`.

Grant your account access to the vault (one-time, needs vault admin rights). This is one line, so it works in both shells:

```bash
az keyvault set-policy --name <your-vault-name> --upn <your-email> --secret-permissions get list set
```

Store your SurveyMonkey access token:

```bash
npm run setup-oauth -- --store-token     # you already have a token
npm run setup-oauth -- --full-flow       # or walk the OAuth flow
```

Then follow steps 3 to 7 from your platform's section above. Leave `SECRETS_BACKEND` at its default of `keyvault`.

## Deploying to Azure

1. Create a Function App with a System-Assigned Managed Identity enabled.
2. Grant that identity `get` and `list` permissions on your Key Vault secrets.
3. Grant that same identity the **Storage Blob Data Contributor** role on the
   storage account the sync writes to.
4. Set the application settings — `KEY_VAULT_URI`, `SM_API_BASE_URL`,
   `SM_ACCESS_TOKEN_SECRET_NAME`, `SECRETS_BACKEND=keyvault`,
   `STORAGE_ACCOUNT_URL`, `STORAGE_CONTAINER`, and `SYNC_SCHEDULE`.
   `local.settings.json.example` documents every setting and its default.
5. Deploy: `func azure functionapp publish <app-name>`.
6. Trigger a first sync with `POST /api/sync` (admin key) rather than waiting
   for the timer.
7. Get the function key from the portal (Function App → App keys) and use it
   as the Power BI credential.

`SYNC_SCHEDULE` must be set — the timer trigger reads it by name, so the
Function App won't start without it.

A one-click "Deploy to Azure" button with a Bicep template is on the roadmap.

## The setup wizard

Once deployed, open the wizard in a browser and it walks you through the whole
thing — getting a SurveyMonkey token, choosing which surveys to sync, running
the first sync, and generating your Power BI connection details:

```
https://<your-function-app>.azurewebsites.net/api/ui?code=<your-master-key>
```

The master key is in the Azure portal under Function App → App keys →
`_master`. Running locally, `http://localhost:7071/api/ui` is enough — keys
aren't enforced.

The wizard is plain HTML, CSS and JavaScript with no build step, so you can
edit it by cloning the repo and opening `public/`. Everything it does is also
available as a plain HTTP API if you'd rather script it — see
[`docs/setup-api.md`](docs/setup-api.md).

## Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/health` | function key | Liveness check; confirms Key Vault is reachable. Does not call SurveyMonkey. |
| `GET /api/surveys` | function key | Lists surveys visible to your token. Use it to find survey IDs. |
| `GET /api/surveys/{surveyId}/data/{table}` | function key | **The Power BI feed.** Serves a synced table. `?format=json`, `?snapshot=YYYY-MM-DD`. |
| `GET /api/surveys/{surveyId}/status` | function key | Last sync time, row counts, available snapshots. |
| `POST /api/sync` | admin key | Syncs every configured survey now. `?full=true` re-pulls everything. |
| `POST /api/sync/{surveyId}` | admin key | Syncs one survey now. |
| `GET /api/surveys/{surveyId}/flattened-responses` | function key | Direct mode: pulls and flattens live, storing nothing. |
| `GET /api/setup/status` | admin key | Setup state: token, storage, config, what to do next. |
| `POST /api/setup/token` | admin key | Validate and store a pasted SurveyMonkey token. |
| `POST /api/setup/oauth/start` | admin key | Begin the guided OAuth flow. |
| `GET /api/setup/oauth/callback` | *anonymous* | OAuth redirect target; secured by one-time `state`. |
| `GET /api/setup/surveys` | admin key | Survey browser with selection and sync state. |
| `GET`/`POST /api/setup/sync-config` | admin key | Read or change which surveys sync, history, retention. |
| `GET /api/setup/connection-info` | admin key | Power BI URLs and a generated Power Query script. |
| `GET /api/ui` | admin key | The setup wizard. |

Sync also runs automatically on the `SYNC_SCHEDULE` timer (default: every six
hours).

`{table}` is one of `surveys`, `questions`, `choices`, `responses`, `answers`,
or `flat`. The data endpoints read files the sync already produced, so they
make no SurveyMonkey API calls — which is why Power BI can refresh as often as
you like.

The `/api/setup/*` endpoints let you configure the whole thing over HTTP
rather than by editing application settings — they're what the setup wizard
will be built on, and you can drive them with `curl` today. See
[`docs/setup-api.md`](docs/setup-api.md) for a complete walkthrough.

### Output schema

Each sync writes six CSV files per survey:

| File | Grain | Notable columns |
|---|---|---|
| `surveys.csv` | 1 row per survey | title, language, question_count, response_count |
| `questions.csv` | 1 row per question | heading, family, subtype, page/position |
| `choices.csv` | 1 row per choice, matrix row, or "other" option | text, kind, **weight**, is_na |
| `responses.csv` | 1 row per response | status, collector, dates, time spent, language |
| `answers.csv` | 1 row per answer | choice_id, row_id, row_text, **value_text**, **value_numeric**, other_text, is_skipped |
| `flat.csv` | 1 row per answer | everything above joined into one table, for simple use |

`value_numeric` is what makes rating scales aggregatable — a 1–5 satisfaction
question gives you the number, not just the label.

### Storage layout

```
{surveyId}/latest/{table}.csv        current data
{surveyId}/snapshots/{date}/...      frozen copies (when history is enabled)
{surveyId}/state.json                last sync time, watermark, row counts
```

## Connecting Power BI

The quickest version: Power BI Desktop → **Get Data** → **Web** →
**Advanced**, with

- URL: `https://<your-app>.azurewebsites.net/api/surveys/<surveyId>/data/flat`
- Header: `x-functions-key` = your function key

That gives you one wide table. For the full five-table model — including a
copy-paste Power Query script that loads all of them, the relationships to
create, ready-made DAX measures, and how to make scheduled refresh work in the
Power BI Service — see **[`docs/powerbi.md`](docs/powerbi.md)**.

Supply the key as a header rather than in the URL so it isn't stored in plain
text in the query string.

## Current limitations

- **Setup is manual.** Deploying, storing a token, and configuring app
  settings are all hand-done today. The setup wizard and one-click deploy are
  the next milestones.
- **First sync of a very large survey can hit the Function timeout.** It's a
  full pull, and Consumption plans cap at 10 minutes. Later syncs are
  incremental and much faster. Narrowing `SYNC_SURVEY_IDS` works around it.
- **Data is as fresh as the last sync.** A six-hour schedule means data up to
  six hours old. Tighten `SYNC_SCHEDULE` or call `POST /api/sync`.
- **One survey per request.** Cross-survey dashboards need one query per
  survey, unioned in Power Query.
- **No automated token refresh**, because SurveyMonkey doesn't offer it. A
  revoked token surfaces as a clear 502; recovery is re-running the setup
  script.

## Contributing

Contributions are very welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).
Good first issues are labelled in the tracker, and
[`docs/ROADMAP.md`](docs/ROADMAP.md) shows where the project is heading if
you want to take on something larger.

## Security

Please report vulnerabilities privately — see [`SECURITY.md`](SECURITY.md).
Do not open a public issue for a security problem.

## License

[MIT](LICENSE)

## Disclaimer

This is an independent project. It is not affiliated with, endorsed by, or
sponsored by SurveyMonkey or Microsoft.
