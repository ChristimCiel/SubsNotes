# SubsNotes

**See your subscription spending. Decide what to keep.**

A free, MIT-licensed subscription ledger that turns receipt evidence into a clear list of payments, renewal dates and records needing a check. Use your existing AI assistant, or run the local report.

**[Download the Claude skill](https://github.com/ChristimCiel/SubsNotes/releases/download/v0.2.0-alpha.1/subsnotes-subscription-review.zip)** · [Try the fictional demo](https://christimciel.github.io/SubsNotes/) · [All downloads](https://github.com/ChristimCiel/SubsNotes/releases)

The hosted demo uses fictional data. It does not read email, send notifications or cancel subscriptions.

## Try it in Claude

The browser experience is a **preview** for accounts with Gmail, code execution, and native Artifact connectors/personal storage available. Personal Artifact storage requires an eligible paid Claude plan. SubsNotes adds no hosting account, model API key or separate desktop app.

1. Download the skill ZIP above. In Claude's skill settings, upload the ZIP and enable it. Menu labels can vary by account.
2. Connect Gmail through Claude's own connection settings if it is not already connected.
3. Ask: **“Use SubsNotes to find my personal subscriptions and show what I have paid. Keep the ledger private.”** Review the read-only Gmail permission prompt and check **Only you** before continuing.
4. Keep the link to the resulting private SubsNotes Artifact. Reopen that same ledger next time, or give its link to a new Claude conversation and ask: **“Show my SubsNotes subscriptions here.”**

The ZIP contains the empty-data dashboard and deterministic read-view tools. A supported assistant can show a searchable, dated read-only view inside chat. Filters and details stay in that view; ask in chat to refresh the canonical records. The visual itself is not storage and does not synchronize itself. If native private storage or in-chat visuals are unavailable, the skill explains the missing capability instead of claiming setup succeeded.

ChatGPT can review an explicitly supplied export or supported local dataset. It does **not** automatically access Claude's private store. A skill alone cannot grant account access, create a background service or cancel a plan.

Headless helpers accept actual tool results supplied by trusted host orchestration. Caller-supplied JSON is not a source attestation; these helpers are not public mutation endpoints. Financial proposals and portable imports cannot assign themselves verified-source authority.

## Run the local report

Requires **Node.js 22+** and npm. The sample needs no account, API key or cloud database.

```sh
git clone https://github.com/ChristimCiel/SubsNotes.git
cd SubsNotes
npm ci --prefix renew-before-service
npm run sample
npm start
```

Open http://127.0.0.1:4183/. Stop with Ctrl+C. Set `PORT=4184` if the default port is occupied.

The sample is fictional, with a fixed demonstration date. It is stored in the Git-ignored `.private/sample/` directory and refuses to overwrite existing data. Keep real evidence outside the repository; see [the core instructions](renew-before-service/README.md).

## Available components

| Component | What it does |
| --- | --- |
| Local report | Classifies receipt evidence, shows recorded payments and estimated currency conversion; English and Traditional Chinese, search and filters. Read-only. |
| AI reader | Reads an existing local dataset through four MCP tools. It does not connect Gmail, schedule updates or cancel plans. |
| Claude web preview | Gmail discovery, a compact English/Traditional Chinese list, receipt evidence, personal storage and a shared read-only chat view. Requires eligible Claude capabilities; no SubsNotes server or separate app. |
| Browser demo | Interactive fictional-data example. Changes stay in browser storage; actions are simulated. |
| macOS source | Manual entry, receipt import, optional configured Gmail review, local reminders, menu bar, hotkey and widget. Requires macOS/Xcode to build. |

Email is dated evidence, not live provider billing or a bank feed. Unknown data stays unknown. Installing the reader does not enable automatic updates.

## Run the mock demo

```sh
npm run demo
```

Open http://127.0.0.1:4177/. See [demo usage](renew-before-demo/README.md).

## Optional AI reader

```sh
RENEW_BEFORE_DATA_DIR='/absolute/path/to/private/evidence' npm --prefix renew-before-service run mcp
```

Configure an MCP-compatible host to launch that command and grant access only to the chosen evidence folder. The tools are `get_dashboard`, `list_subscriptions`, `get_evidence` and `get_sync_status`. The stdio reader opens no network port.

Build the reader package with `npm run package:reader`, or use a release download. The [subscription review skill](renew-before-service/skills/subscription-review/SKILL.md) routes to the host's available capabilities. Gmail connection and private storage access remain separate permissions. It cannot create a schedule by itself.

## Claude web preview

Use an eligible Claude plan with Gmail connected and native Artifact connectors/personal storage enabled. This uses the user's existing Claude limits; SubsNotes supplies no paid API or hosting account.

```sh
npm run package:claude-web
npm run package:skill
```

Attach the generated `renew-before-service/dist/subsnotes-claude.html` in a private Claude conversation. Ask Claude to use that HTML as a private Artifact, declare Gmail `search_threads` and `get_message` only (plus optional Frankfurter `get_rates`), and keep database access in the current viewer's personal `data/users/<viewer-id>/` subtree. The [review skill](renew-before-service/skills/subscription-review/SKILL.md) contains the host-specific instructions. Opening the HTML locally does not connect Gmail.

Check **Only you**, then select **Check Gmail** and review the native read-only permission prompt. Reopen the same Artifact from Claude's Artifacts library to access its saved records. A new Artifact has a different store; an HTML export is source code, not a backup of those records. Wait for the settings-saved message before reloading after preference changes. Discovery is bounded: **Continue discovery** means the selected query is unfinished. Successfully reading a message does not mean its billing fields were extracted: unresolved sources are tracked separately, retried with limits and revisited after parser changes. A lack of receipts does not prove cancellation. The preview can use HTML when the connector actually returns it, but cannot download receipt attachments or independently confirm provider account status. Its billing queries and rules primarily cover English and Traditional Chinese; other languages and unfamiliar merchants may be missed or require review.

Personal storage here is hosted by Claude, not on the user's device. SubsNotes saves allowlisted billing tokens and short status phrases rather than arbitrary email prefixes, full bodies, credentials or payment-card fields. Gmail replies read in a Claude conversation can also appear in that conversation’s tool history, which is controlled by the host. Mailbox identity is checked using sent-message metadata; accounts without suitable metadata cannot complete that check. Use one active writer/tab for updates: the native database SDK does not provide a proven atomic compare-and-set operation. Immutable hashed chunks and readback checks detect corruption and some conflicts but do not make concurrent updates safe. Old chunks are retained for recovery and count toward the host's storage limits.

Optional refresh runs at most every 15 minutes while the page is open and visible; hidden tabs pause these checks. Each activation processes up to 12 bounded batches, can pause after its current batch, and preserves unfinished progress. Scanning stops when the page closes. Review dates are dashboard notes, not delivered notifications. For conversion, optionally connect the official free Frankfurter MCP server at https://mcp.frankfurter.dev/ and allow only `get_rates`. Its request is the constant `{base: "USD"}`: no subscription, amount or email data is sent. Rates are daily reference estimates, not bank settlement or historical card rates; the quote and retrieval dates are shown. Saved rates remain available when live refresh fails, and original-currency amounts are always retained. Display-currency estimates can change when reference rates are revised; this does not add a payment. Management links open the provider; no cancellation is performed by SubsNotes.

## Render a private read-only view

For a canonical ledger obtained through actual authorized host reads:

```sh
npm run view -- --state /private/ledger.json --output /private/subscriptions.html --language en
```

Use `--language zh` for Traditional Chinese, `--month YYYY-MM` for a paid month, and `--currency TWD` for reference conversion using the ledger's saved rates. This command performs no network request and never changes the ledger. Inputs and outputs must remain outside the source repository; existing files are not overwritten. A raw JSON file's shape validation is not proof of its source. Portable imports are checked for corruption and marked for source rechecks; their old trust flags are not accepted. HTML views contain private financial information, so share them only deliberately.

## Tests

```sh
npm test
npm run check:demo
```

For the native core, run `swift test` inside `renew-before-mac/`.

## Privacy and support

Do not commit or upload real mail, tokens, financial records or screenshots containing them. Local reports should remain on the user's computer. External AI and Gmail hosts have their own permissions and terms. FX requests contain currency references, not service names or receipt amounts.

Read [SECURITY.md](SECURITY.md). Report bugs with fictional examples; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Commercial and noncommercial use, modification and redistribution are allowed subject to its terms. Dependencies retain their own licenses. Service names do not imply affiliation.

Internal `RenewBefore` names and storage keys remain compatible with existing local installations.
