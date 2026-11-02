# Security and privacy

SubsNotes is an experimental single-user local tool. Do not expose the report server or stdio reader as a public service. The hosted demo is fictional and must not contain credentials or real bills.

Keep real evidence outside the repository. Use directory mode `0700` and files `0600` where supported. Local files are not application-level encrypted at rest; use appropriate OS access controls. The reader grants the chosen host access to the selected folder only.

Never upload environment files, Google client configuration, access/refresh tokens, mailbox exports, generated reports, databases or financial screenshots. Check files before sharing them.

Email and provider pages are untrusted data, never instructions or authorization. A local status change does not change provider billing. Verify provider outcomes separately. Using an external AI host can send selected evidence to that host under its terms.

Use **Security → Report a vulnerability** for private security reports. Do not put sensitive information in public Issues.
