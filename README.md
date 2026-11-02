# SubsNotes

**See your subscription spending. Decide what to keep.**

A free, MIT-licensed, local-first subscription management project with a receipt report, optional read-only AI tools, an interactive mock demo, and an experimental macOS app.

**[Try the demo](https://christimciel.github.io/SubsNotes/)** · [Downloads](https://github.com/ChristimCiel/SubsNotes/releases) · [macOS setup](renew-before-mac/README.md)

The hosted demo uses fictional data. It does not read email, send notifications or cancel subscriptions.

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

Build the reader package with `npm run package:reader`, or use a release download. The [subscription review skill](renew-before-service/skills/subscription-review/SKILL.md) needs the host's separately connected Gmail and local file access. It cannot grant permissions or create a schedule.

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
