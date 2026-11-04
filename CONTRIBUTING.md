# Contributing

[English](CONTRIBUTING.md) · [繁體中文](CONTRIBUTING.zh-TW.md)

Small fixes, clearer translations, accessible interactions and reproducible bug reports are welcome.

## Report a bug

First check [troubleshooting](guide/en/help.md). In a public Issue, include:

- The version, language, host/browser and whether you used the fictional demo or a private ledger.
- Short steps to reproduce, expected behavior and actual behavior.
- A fictional example or a screenshot from the synthetic demo.

Do not attach actual bills, mailbox exports, private links, account details or credentials. For a security issue use [private reporting](SECURITY.md).

## Run the project

Requires Node.js 22+ and npm. From the repository root:

```sh
npm ci --prefix renew-before-service
npm test
npm run check:demo
```

Use `npm run sample` and `npm start` for the fictional local report. Native changes also need `swift test` in `renew-before-mac/` and the documented macOS build tools.

Keep changes focused and reuse the shared calculation and persistence rules. Use synthetic fixtures. Preserve original currencies, exact-date/month precision, evidence provenance, user confirmations and backward compatibility. Do not introduce a fake payment day to simplify a month-only record.

User-facing copy belongs in the locale resources. Update `en` and `zh-TW` together, including validation and error text. Keep the legacy `zh` preference/import alias compatible. Use the shared regional formatters rather than constructing dates or currency symbols in UI strings.

## Submit a change

Describe the user-visible behavior and relevant checks. Keep real datasets and internal maintainer notes out of the change and its attachments. Public screenshots must show explicit synthetic/demo data. See [security guidance](SECURITY.md) before sharing anything.

## License and third-party material

Contributions are submitted under the existing [MIT license](LICENSE); contributors retain copyright. There is no additional contributor license agreement. Submit only material you have permission to license. Keep dependency, artwork and trademark notices, and do not copy another project's screenshots or branding into this one.
