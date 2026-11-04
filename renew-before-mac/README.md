# SubsNotes macOS app — experimental source

This experimental native app retains the internal **Renew Before** app name, bundle identifiers and storage paths to preserve existing installations.

It is a separate optional client. For SubsNotes in Claude on the web, follow the [main setup instructions](../README.md#start-in-claude); this native app is not required. The alpha.12 release does not include a ready-to-install macOS app.

## Existing features

- English and Traditional Chinese in Settings.
- Manual subscription entry, receipt import and last-verification dates.
- Decisions, paid history, per-currency recurring estimates, project dates and receipt review.
- Optional Gmail sign-in and on-demand discovery with review before saving.
- Menu bar, Dock reopening, normal-level window, **⌥⌘R** hotkey and WidgetKit source.
- Local reminder scheduling and notification-permission status; scheduling does not prove delivery.

Keep records a local decision. Stop renewing opens the original purchase channel and asks for confirmation; it does not execute cancellation. Access and payment history remain separate. No computer-use or browsing-history monitoring is enabled.

## Build without a paid developer account

Requires macOS 14+ and full Xcode 16+ selected as developer directory. No third-party Swift dependencies are required.

```sh
swift test
RENEW_SIGNING=adhoc ./Scripts/build.sh
./Scripts/doctor.sh "$(./Scripts/build.sh --print-app-path)"
```

This builds without installing or opening the app. `./Scripts/install.sh` copies to `~/Applications/Renew Before.app`, opens it, and refuses to overwrite an existing installation. Back up data before deliberately replacing one.

`./Scripts/package.sh` creates a local disk image. Local signing is not Developer ID notarization; no App Store release is required. This baseline does not advertise an unsigned binary as a frictionless public installer.

## Optional Gmail configuration

An unconfigured source build offers setup. Create your own Google **Desktop app** OAuth client, enable Gmail API, configure consent and read-only Gmail scope, and choose its JSON in that screen. Developers can place it at `App/GmailDesktopClient.json` before building; Git ignores it. No publisher client or token is included.

Testing accounts and publicly verified onboarding differ. See [native OAuth](https://developers.google.com/identity/protocols/oauth2/native-app) and [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).

Scans run only when requested. They look back 90 days and inspect up to 30 billing messages plus 30 additional receipt messages. Limited text-PDF extraction is supported; unsupported receipts need manual review. Coverage can miss annual bills and other accounts. A receipt does not establish current access or the next charge.

OAuth sessions use Keychain. Suggestions and confirmed subscription/payment fields stay local. Disconnecting/revoking access and deleting financial records are separate actions.

## Service identifiers

The public source uses initials and service-name aliases. No third-party logo image binaries are included. See [third-party notices](THIRD_PARTY_LOGOS.md).

## Tests and AI setup

`Tests/` uses fictional fixtures. Read `IntegrationTests/` scripts before running: some launch UI or exercise OS permissions. Never automate a real provider cancellation as a test.

The [setup skill](skills/renew-before-setup/SKILL.md) can guide source setup; users must still approve permissions, connect their own account and confirm consequential actions. Private screenshots and account logs are not included.
