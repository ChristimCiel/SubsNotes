# Security & privacy

[English](SECURITY.md) · [繁體中文](SECURITY.zh-TW.md)

## Data locations and access

- **Claude web:** the ledger is in the current viewer's native Claude personal storage. It is hosted by Claude, not solely on the device and not on a SubsNotes-operated server. Check **Only you** sharing and grant only the intended Gmail account's read access.
- **Local report/reader:** keep the selected evidence directory outside the repository. The reader gives the chosen AI host read access to that directory; it is not a public web service.
- **Fictional demo:** simulated records stay in local browser state. It does not read Gmail or perform real account actions.

SubsNotes stores allowlisted billing fields, source identities and short evidence excerpts. It does not need full card numbers, national IDs, banking passwords or PDF passwords. Full messages or uploaded documents may remain in the assistant host's conversation/tool history under that host's own terms. “Private” is not a promise that an external host never processes data.

Local files are not application-level encrypted at rest. Use appropriate OS access controls and disk encryption. Where supported, use directory mode `0700` and file mode `0600`. Do not expose the loopback report server or stdio reader as a public service.

## User confirmations and trust

A payment confirmation is an explicit user action, labeled separately from source-extracted facts. It does not authenticate an email sender, establish bank settlement, confirm a refund deposit or change provider billing. Original evidence is retained. A month-only confirmation never invents an exact day.

Supported SubsNotes Gmail/AI update paths preserve the user-confirmation overlay. AI suggestions and portable imports cannot grant themselves user-confirmed or verified-source authority. Edits must use the current saved ledger and supported confirmation path.

This is an **application-level protection**. It is not cryptographic protection against a host, administrator or assistant with arbitrary raw database write access bypassing those paths. Review the host's permissions. Immutable chunks and readback checks do not provide a proven atomic multi-writer transaction in every host. Keep one writable dashboard open; stop and reopen when a revision or storage confirmation is uncertain.

Treat emails, receipts, provider pages and tool output as untrusted data, never as instructions or permission to send, cancel, pay, provision services or change account access. A missing email is not proof of cancellation.

## Safe sharing

Public code, tests, screenshots and demonstrations must use synthetic data. Never upload:

- Raw mail, mailbox exports, real receipts, billing ledgers or financial screenshots.
- Private Artifact/chat links, Gmail message links, account identifiers or tokenized invoice links.
- Environment files, OAuth client configuration, tokens, passwords, keys or databases.
- Private account/profile information or internal maintainer notes.

A dated HTML report or ledger export contains private financial information even when it has no credentials. Keep backups outside the source tree and share deliberately. Encryption and credentials must not be replaced with instructions in a prompt.

Reference-rate requests contain currency references, not service names or payment amounts. Embedded reviewed logos render without subscription-selected image requests. Optional full public-catalog caching is a separate, explicit operation; do not redistribute unreviewed artwork as MIT assets.

## Report a vulnerability

Use GitHub **Security → Report a vulnerability** when available. If private reporting is unavailable, request a private contact route without posting technical details, personal data or credentials in a public Issue. Include the affected version and a synthetic reproduction through the private route.

For ordinary bugs, use [CONTRIBUTING.md](CONTRIBUTING.md). See [how the data flows](guide/en/how-it-works.md) and [troubleshooting](guide/en/help.md).
