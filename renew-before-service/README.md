# SubsNotes local report and AI reader

[English guide](../guide/en/how-it-works.md) · [繁體中文使用指南](../guide/zh-TW/how-it-works.md)

This directory also contains the shared billing core and Claude web dashboard/skill. For the main Claude web experience, follow the [main setup instructions](../README.md#start-in-claude). The instructions below cover the optional local report and MCP Reader, which read a separate local dataset and do not automatically access the Claude web ledger.

Requires Node.js 22+. The report is read-only and supports English/Traditional Chinese, evidence filters, recorded payments and estimated display-currency conversion.

From the repository root, run `npm ci --prefix renew-before-service`, `npm run sample`, then `npm start` for fictional data.

## Use private evidence

Store real data outside the repository, with directory mode `0700` and files `0600` where supported. Never place real receipts in samples or public Issues.

The importer reads arrays from `messages-0.json`, `messages-1.json`, and similar files. Each message has `id`, `receivedAt`, `sender`, `subject`, `text` or `html`, and optional `mailboxEmail`. Supply `authenticatedSenderDomain` only when receiving-provider authentication was checked; a sender header is not authentication.

```sh
node scripts/audit.mjs '/absolute/path/to/private-evidence'
npm start -- --report '/absolute/path/to/private-evidence/review.html'
```

The report server binds to loopback at http://127.0.0.1:4183/. It does not serve a directory listing or raw mail. Reloading reads the saved report and never scans Gmail. Set `PORT` for another local port.

## Read the amounts and dates

- Receipts are dated evidence, not live billing or bank confirmation. Missing mail does not prove cancellation.
- Renewal settings, paid access, next billing, trial and cancellation deadlines are distinct. Passed dates do not advance automatically.
- Amount paid, full price and stated future price are separate. Discounts and prorations do not establish the ongoing rate.
- Gross recorded subscription receipts exclude refunds and one-time purchases. They are not net or bank-reconciled spending.
- Unknown currencies, ambiguous dollar symbols and conflicting evidence stay outside unified totals.

Display conversion uses daily reference rates from Frankfurter, with Currency API fallbacks. Original amounts remain unchanged. Rate date/source and incomplete totals are visible. These are estimates, not historical card settlement or intraday rates. Requests send currency references rather than account or receipt details. Cached/original amounts remain available when providers fail.

## AI reader

```sh
npm ci
RENEW_BEFORE_DATA_DIR='/absolute/path/to/private-evidence' npm run mcp
```

Configure a compatible host with this command. It exposes four read-only tools and opens no network port. It cannot authorize Gmail, cancel a plan or create a schedule.

Build the local reader with `npm run package:mcpb`; output is `dist/SubsNotes-Evidence-Reader-<manifest-version>.mcpb` (the exact filename is printed by the builder). A user selects the existing evidence folder during setup. The technical identifier and `RENEW_BEFORE_DATA_DIR` setting remain compatible with earlier local installations.

The [subscription review skill](skills/subscription-review/SKILL.md) provides usage instructions for a host with separately authorized Gmail and local file tools. A failed or partial refresh must not claim a successful mailbox check. Google OAuth setup and host permissions are not supplied by installing this reader.

Run `npm test` for the fictional-data tests. See [security guidance](../SECURITY.md) before sharing data.

## Optional public artwork cache

Bundled reviewed marks retain their owner notices and use initials when unavailable. The separate integration directory is a dated public snapshot, not permission to redistribute every image.

From the repository root, an explicit full-catalog cache can be created outside the source tree:

```sh
npm run cache:logos -- --all-public-catalog --directory /private/subsnotes-logo-cache
```

This can take several minutes and hundreds of MB. It downloads the whole public catalog, not an account's subscription-selected brands, and is not needed for normal use. Add `--logo-cache /private/subsnotes-logo-cache` to a supported view command to embed local matching images. Do not commit or redistribute this unreviewed cache as MIT artwork.
