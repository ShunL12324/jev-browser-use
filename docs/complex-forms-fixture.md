# Complex React application fixture

Local synthetic hiring application. No real person, employer account, recruiting submission, or cloud deployment is involved. This package is independent of the root workspaces and core browser protocol.

## Start and reproduce

```sh
cd examples/complex-forms
npm ci
npm run build
npm test
npm start
# Other terminal; isolated Playwright browser, never the user's browser:
CHROMIUM_PATH=/path/to/chromium npm run test:browser
```

Node 22+ recommended. The server binds only `127.0.0.1`, default port **17431**, overridable with `PORT`. `npm start` serves the real Vite application in middleware mode; `build` separately verifies production bundling. Use an installed Chromium via `CHROMIUM_PATH`, or install the package's browser with `npx playwright install chromium` within this package. No root dependency changes are needed.

The mechanical script always uses **atlas / standard**. It drives actual UI events and file selection and checks the independent HTTP oracle. It does not represent Jev performance or success. It writes ignored `artifacts/mechanical.json` and `artifacts/mechanical.png` and closes its isolated browser.

`birch / standard` and `atlas / alternate` are reserved for independent validation, not used for implementation-time browser tuning. Alternate places the guidance panel on the right and stacks inputs; it uses the same state, labels, validation and controls. It is a modest layout variation, not a separate unseen website or proof of generalization.

## Public host contract

Create a fresh isolated run:

```sh
curl -s http://127.0.0.1:17431/api/reset \
  -H 'Content-Type: application/json' \
  -d '{"seed":"atlas","variant":"standard"}'
```

Response: `{runId,url,taskData,resume,variant}`. `url` is relative (`/?run=<uuid>`). Seeds are `atlas` and `birch`; variants are `standard` and `alternate`. Reset allocates a new run and leaves existing runs intact. Runs are in server memory; restarting the server deletes them.

- `GET /api/task/:runId`: `{taskData,resume}` for the **host**. `resume` has absolute local `path`, `name`, `size`, MIME `type`, and `sha256`. Host grants the path through its file authorization mechanism and gives the model only an authorized file ID and task values.
- `GET /api/session/:runId`: only `{variant}`, fetched by UI. No answers are returned to the page.
- `GET /api/cities?country=Canada`: regular asynchronous city choices, 350 ms delay.
- `GET /api/email?value=...`: syntactic email availability, 300 ms server delay plus 250 ms client debounce. Addresses starting `taken@` are unavailable. No task answer comparison occurs here.
- `POST /api/submit/:runId`: multipart with one `payload` JSON field and one `resume` file. UI uses React state plus the browser-selected File object. 2 MiB limit; actual received bytes hashed on server. Response is `{accepted,receipt,error}`, 200 or 422. Malformed requests return 400.
- `GET /api/oracle/:runId`: **host-only evaluation use**, never add to model context. `{submitted,attempts,passed,correctFields,totalFields,fieldChecks,unexpectedFields,structureErrors,upload}`. Each check includes `{field,expected,actual,correct}`. Upload includes received name, type, size, SHA-256, expected size/hash, and correctness. Before submission it reports `submitted:false`, `passed:false`, 0/32 correct and missing upload. These endpoints are local test instrumentation, not an authentication boundary.

The browser never fetches task or oracle routes. The front-end does not import seed data, attach state to `window`, or offer a prefill/skip/robot route. Review displays only the user's entered React state. A direct host submission can test the oracle but cannot count as browser completion.

## Required values and control map

**32 scalar values + 1 uploaded file = 33 required entries.** A successful main scenario requires two work rows and one education row. UI starts with one work row; task data gives all required rows. Additional education rows can be created and removed. Server rejects extra payload leaves and wrong types as well as wrong values.

| Stage | Payload key | Visible label / context | Control | Count |
|---|---|---|---|---:|
| Contact | personal.name/email/phone | Full name / Email / Phone | text, email, tel | 3 |
| Contact | personal.country/city | Country / City | native selects; async country→city | 2 |
| Contact | personal.address/postal | Street address / Postal code | text | 2 |
| Preferences | preferences.role | Target role | custom button + listbox/options | 1 |
| Preferences | preferences.mode | Work arrangement; Remote / Hybrid / On-site | radio | 1 |
| Preferences | preferences.salary/startDate | Expected annual salary / Available start date | number, date | 2 |
| Preferences | preferences.sponsorship/visa | Require sponsorship / Visa category | native selects; visa conditional on Yes | 2 |
| Experience | experience.0 / experience.1 | fieldset legends Work experience 1 / Work experience 2 | dynamic rows | 10 |
| Experience | education.0 | fieldset legend Education 1 | dynamic rows | 4 |
| Skills | skills.0.name/level, skills.1.name/level | Skill 1 / Proficiency 1; Skill 2 / Proficiency 2 | editable table with text/select | 4 |
| Skills | consent | I consent to processing this application | checkbox | 1 |
| Skills | multipart resume | Résumé PDF | genuine file input | 1 file |

Work row labels: **Company**, **Job title**, **Start date**, **End date**, **Responsibilities**. Education labels: **School**, **Degree**, **Subject**, **Graduation year**. Repeated names are deliberately disambiguated by visible fieldset legend, not hidden unique automation labels. Native option values equal their visible labels; number values must be JSON numbers and consent a boolean. The task endpoint provides concrete values; there are no defaults filled with correct answers.

## Manual completion and difficulty

Open the reset URL, copy the supplied task values into Contact, wait for email availability and city choices, then Continue. Choose the custom role option, a work arrangement radio, salary/date and sponsorship/visa. Add the second work experience and fill both visible groups plus education. Fill the two skill-table rows, attach the supplied PDF and consent. Continue to Review, optionally Back to edit; Submit application opens a native modal dialog, and Confirm and submit performs the actual request. The host then checks the oracle, not receipt text alone.

React `useState` controls all scalar inputs, selects, radios and checkboxes. Dynamic records have stable per-row IDs. Files retain an actual File object (browsers disallow controlling a file input's value), including across Back/Continue. Country changes clear City and ignore stale async responses. Native required constraints and step-specific checks gate progression. Conditional visa is mounted only for sponsorship Yes. Work dates are ordered. The custom listbox opens by button activation; its focusable options can be keyboard activated, and Escape closes it. Background controls are ordinarily available; only the standard native modal confirmation makes the background inert.

## Oracle and fixtures

`data.mjs` is server-only, with frozen seed definitions independent of submitted UI state. Oracle flattens every expected leaf and uses strict equality; it also rejects unexpected leaves, container type mismatches, extra empty properties, and array-length mismatches. Upload verification uses received bytes, MIME and size, never just a filename or client-provided hash. Oracle success requires actual submission. This verifies requested values; it does not claim a production hiring service or enforce every conceivable application rule.

`fixtures/atlas.pdf` and `fixtures/birch.pdf` are deterministic one-page PDFs containing only a synthetic fixture notice. Regenerate with `python3 fixtures/generate.py`. Names and contact data use explicit Example/Sample labels and `.test` domains.

`npm test` covers unsubmitted state, missing fields, wrong field, wrong PDF bytes, absent upload, extra field, wrong numeric type, both correct seeds, and fresh reset. Mechanical checks cover required-field blocking, async city change, dynamic work/education add/remove, upload retention after Back, canceling confirmation, complete UI submission, server 32/32 and matching PDF, and browser runtime errors. These are fixture tests, explicitly separate from core adapter and paid Jev evaluation.

## Implementation self-check (2026-09-22)

Node v24.13.0; Chrome for Testing 149.0.7827.55; package-local Playwright 1.55.1. Production build and HTTP oracle integration tests passed. Final atlas/standard mechanical run passed in 3312 ms with 32/32 scalar matches, 631 received PDF bytes, SHA-256 `524cd584816c75852d0214454768854cbb7b2e62aa9d28b7114d80683953b14c`, and no browser page errors. This short host-driven time excludes build/startup and is **not** a Jev benchmark. Initial mechanical execution exposed a changing file-input accessible name caused by adjacent attachment help text; the final input has a stable explicit `aria-label="Résumé PDF"` while preserving visible help. The following complete runs passed. Independent validator review also identified flatten-only container ambiguity; recursive structural checks and all three reported negative cases are now included.
