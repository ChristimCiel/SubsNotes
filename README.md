# SubsNotes

**See your subscription spending. Decide what to keep.**

A free, MIT-licensed subscription ledger that turns receipt evidence into a clear list of payments, renewal dates and records needing a check. Use your existing AI assistant, or run the local report.

**[Download the Claude skill](https://github.com/ChristimCiel/SubsNotes/releases/download/v0.2.0-alpha.7/subsnotes-subscription-review.zip)** · [Try the fictional demo](https://christimciel.github.io/SubsNotes/) · [All downloads](https://github.com/ChristimCiel/SubsNotes/releases)

The hosted demo uses fictional data. It does not read email, send notifications or cancel subscriptions.

**Likely inactive** is an estimate from dated billing evidence: a renewal more than 60 days overdue without later payment, or multiple distinct unresolved expiry/payment warnings. Recorded cancellations, reported expiry and payment issues remain separate. Open details for qualitative evidence strength and original emails. Missing mail can change the conclusion; no status cancels the provider's plan or deletes payment history.


## Try it in Claude

The browser experience is a **preview** for accounts with Gmail, code execution, and native Artifact connectors/personal storage available. Personal Artifact storage requires an eligible paid Claude plan. SubsNotes adds no hosting account, model API key or separate desktop app.

1. Download the skill ZIP above. In Claude's skill settings, upload the ZIP and enable it. Menu labels can vary by account.
2. Connect Gmail through Claude's own connection settings if it is not already connected.
3. Ask: **“Use SubsNotes to find my personal subscriptions and show what I have paid. Keep the ledger private.”** Review the read-only Gmail permission prompt and check **Only you** before continuing.
4. Keep the link to the resulting private SubsNotes Artifact. Reopen that same ledger next time, or give its link to a new Claude conversation and ask: **“Open my saved SubsNotes dashboard.”**

**For fast reopening, bookmark and open the same private Artifact.** It reads your saved ledger directly instead of asking AI to regenerate HTML. **Refresh** reloads saved records; **Check Gmail** searches for billing changes. Search, filters and period/currency choices remain usable during synchronization. Private records are not copied into a shared cache or hosted by SubsNotes. Selecting a payment month opens **Payments**, whose rows use the same verified transactions as the total. **Subscriptions** is your full plan library; **Other** covers all dates and keeps donations, one-time purchases, invoices and unresolved records separate. Annual charges count in full only in their confirmed payment month. Receipt dates, invoice dates and expected renewals do not establish a payment date.

The ZIP contains the empty-data dashboard and deterministic read-view tools. A supported assistant can show a searchable, dated read-only view inside chat. The view uses a compact panel, up to 760 × 560 pixels, with a scrolling service list and expandable details. Its surrounding iframe size remains under the host's control. Filters and details stay in that view; ask in chat to refresh the canonical records. The visual itself is not storage and does not synchronize itself. If native private storage or in-chat visuals are unavailable, the skill explains the missing capability instead of claiming setup succeeded.

The generated HTML targets compatible visuals, Artifacts or full-screen surfaces. It is not a registered ChatGPT App. ChatGPT's official inline App cards prohibit nested scrolling; a registered App would need a summary card and a full-screen view instead. Claude inline visuals and Artifacts are different surfaces, and mobile availability depends on the host.

Inline visuals remain experimental: a host session can show a blank panel or a visualize display error even with a valid fragment. A prompt cannot repair that host initialization failure. If it happens, use the same private Artifact or request a plain chat table; do not create a replacement ledger or grant extra permissions just to display it.

The reviewed bundle includes 35 product marks across eight owner families: OpenAI, Linear, Vercel, Cursor, Figma, Supabase, Hugging Face and Atlassian. Product marks are not a count of distinct companies. Owner sources, notices and applicable artwork licenses are retained; they are separate from the source-code MIT license. Missing or unavailable images retain readable initials.

For broader coverage, the separate dated directory contains 6,605 public integration records: 5,018 ChatGPT apps in the observed public directory scope, 1,059 Claude connectors and 528 Claude plugins. It includes 5,759 unsigned artwork references. These are not counts of licensed logos or every integration worldwide; some listings publish no artwork, and availability varies by scope and over time.

An optional private artwork cache downloads the whole public snapshot, never subscription-selected image queries. From a checkout, run `npm run cache:logos -- --all-public-catalog --directory /private/subsnotes-logo-cache`; from the installed skill, use `node scripts/cache-service-logos.mjs` with the same arguments. This can take several minutes and hundreds of MB; it is not required to use SubsNotes. Add `--logo-cache /private/subsnotes-logo-cache` to a view command to read matching images locally. Download failures, unsafe files and ambiguous brands remain explicit fallbacks. Cached artwork stays outside the repo and is not redistributed or represented as permission-cleared. No image requests are made while rendering a view.

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

Check **Only you**, then select **Check Gmail** and review the native read-only permission prompt. Reopen the same Artifact from Claude's Artifacts library to access its saved records. A new Artifact has a different store; an HTML export is source code, not a backup of those records. Wait for the settings-saved message before reloading after preference changes. Discovery is bounded: **Continue checking** means the selected query is unfinished. Successfully reading a message does not mean its billing fields were extracted: unresolved sources are tracked separately, retried with limits and revisited after parser changes. A lack of receipts does not prove cancellation. The preview can use HTML when the connector actually returns it, but cannot download receipt attachments or independently confirm provider account status. Its billing queries and rules primarily cover English and Traditional Chinese; other languages and unfamiliar merchants may be missed or require review.

Personal storage here is hosted by Claude, not on the user's device. SubsNotes saves allowlisted billing tokens and short status phrases rather than arbitrary email prefixes, full bodies, credentials or payment-card fields. Gmail replies read in a Claude conversation can also appear in that conversation’s tool history, which is controlled by the host. Mailbox identity is checked using sent-message metadata; accounts without suitable metadata cannot complete that check. Use one active writer/tab for updates: the native database SDK does not provide a proven atomic compare-and-set operation. Immutable hashed chunks and readback checks detect corruption and some conflicts but do not make concurrent updates safe. Old chunks are retained for recovery and count toward the host's storage limits.

Optional refresh runs at most every 15 minutes while the page is open and visible; hidden tabs pause these checks. Each activation processes up to 12 bounded batches, can pause after its current batch, and preserves unfinished progress. Scanning stops when the page closes. Review dates are dashboard notes, not delivered notifications. For conversion, optionally connect the official free Frankfurter MCP server at https://mcp.frankfurter.dev/ and allow only `get_rates`. Its request is the constant `{base: "USD"}`: no subscription, amount or email data is sent. Rates are daily reference estimates, not bank settlement or historical card rates; the quote and retrieval dates are shown. Saved rates remain available when live refresh fails, and original-currency amounts are always retained. Display-currency estimates can change when reference rates are revised; this does not add a payment. Management links open the provider; no cancellation is performed by SubsNotes.

## Render a private read-only view

For a canonical ledger obtained through actual authorized host reads:

```sh
npm run view -- --state /private/ledger.json --output /private/subscriptions.html --language en
```

Use `--language zh` for Traditional Chinese, `--month YYYY-MM` for a paid month, and `--currency TWD` for reference conversion using the ledger's saved rates. This command performs no network request and never changes the ledger. Inputs and outputs must remain outside the source repository; existing files are not overwritten. A raw JSON file's shape validation is not proof of its source. Portable imports are checked for corruption and marked for source rechecks; their old trust flags are not accepted. HTML views contain private financial information, so share them only deliberately.

Add `--surface inline` to produce a content fragment for a compatible in-chat HTML renderer. It retains the same financial data and interactions, omits document-level wrappers and supplies an intrinsic 560px height for host sizing. The default `--surface standalone` retains the complete HTML document and its security policy. An assistant may omit artwork while generating a visual; that is distinct from an image-loading error. Neither a prompt nor a tool-success message guarantees that every host or account displayed the widget.

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
