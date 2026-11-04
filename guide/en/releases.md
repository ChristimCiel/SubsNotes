# Downloads & updates

[English](releases.md) · [繁體中文](../zh-TW/releases.md) · [Home](../../README.md)

For the Claude web experience, [download the alpha.12 skill ZIP](https://github.com/ChristimCiel/SubsNotes/releases/download/v0.2.0-alpha.12/subsnotes-subscription-review.zip) or open the [alpha.12 release page](https://github.com/ChristimCiel/SubsNotes/releases/tag/v0.2.0-alpha.12). It is a published **pre-release**. GitHub's generic “latest” currently points to the older v0.1.0 release, which does not include the Claude skill. See [all releases](https://github.com/ChristimCiel/SubsNotes/releases) to choose another version.

## Choose a file

| File | Use it for |
| --- | --- |
| [`subsnotes-subscription-review.zip`](https://github.com/ChristimCiel/SubsNotes/releases/download/v0.2.0-alpha.12/subsnotes-subscription-review.zip) | Install the skill in a compatible Claude account. This is the usual web starting point. |
| [`subsnotes-claude.html`](https://github.com/ChristimCiel/SubsNotes/releases/download/v0.2.0-alpha.12/subsnotes-claude.html) | Empty-data dashboard source for a compatible private Claude Artifact. Opening it locally does not connect Gmail or storage. |
| [`SubsNotes-Evidence-Reader-0.1.5.mcpb`](https://github.com/ChristimCiel/SubsNotes/releases/download/v0.2.0-alpha.12/SubsNotes-Evidence-Reader-0.1.5.mcpb) | Optional local read-only access to an existing selected evidence folder. It is not needed for Claude web. |
| [`SHA256SUMS`](https://github.com/ChristimCiel/SubsNotes/releases/download/v0.2.0-alpha.12/SHA256SUMS) | Compare the integrity hashes of that release's downloadable files. |
| GitHub source archives | Source code; not a configured account or a copy of your private data. |

## Update without losing the ledger

1. Keep the link to the existing authoritative private Artifact and close other writable copies.
2. Download the selected release's skill and enable the replacement in the host's skill settings.
3. Ask Claude: **“Update my existing private SubsNotes dashboard using this release. Preserve the same ledger, all source records, payment confirmations, history and preferences. Do not create another store.”**
4. Have the host read the current code/data revision before changing it. Use the supported guarded update path, then read back the result.
5. Reopen the same link and inspect your saved records. A skill installation alone is not proof that an existing Artifact's code was updated.

If the host cannot safely update the same private Artifact, keep the existing ledger and report the missing capability. A downloaded HTML file is not a backup of your financial data. Do not replace a newer ledger with an old snapshot to update the interface.

## Check download integrity

If you downloaded all three listed assets and `SHA256SUMS`, verify them from the same folder:

```sh
shasum -a 256 -c SHA256SUMS  # macOS
sha256sum -c SHA256SUMS     # Linux
```

If you downloaded only the skill ZIP, run `shasum -a 256 subsnotes-subscription-review.zip` on macOS or `sha256sum subsnotes-subscription-review.zip` on Linux and compare the matching entry in `SHA256SUMS`.

On Windows, `Get-FileHash -Algorithm SHA256 .\subsnotes-subscription-review.zip` in PowerShell prints a hash to compare with the matching entry in `SHA256SUMS`.

A matching checksum shows that your copy matches the release's listed bytes. It does not independently verify every feature, authorize a connection or make a local dataset trusted.

Keep private backups and exports outside the repository. Do not upload them to Issues or Releases. See [security and privacy](../../SECURITY.md).
