# SubsNotes local report and AI reader

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

Build the local reader with `npm run package:mcpb`; output is `dist/SubsNotes-Evidence-Reader-0.1.0.mcpb`. A user selects the existing evidence folder during setup. The technical identifier and `RENEW_BEFORE_DATA_DIR` setting remain compatible with earlier local installations.

The [subscription review skill](skills/subscription-review/SKILL.md) provides usage instructions for a host with separately authorized Gmail and local file tools. A failed or partial refresh must not claim a successful mailbox check. Google OAuth setup and host permissions are not supplied by installing this reader.

Run `npm test` for the fictional-data tests. See [security guidance](../SECURITY.md) before sharing data.
