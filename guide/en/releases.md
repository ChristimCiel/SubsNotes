# Downloads & updates

[English](releases.md) · [繁體中文](../zh-TW/releases.md) · [Home](../../README.md)

Open the project's [Releases](https://github.com/ChristimCiel/SubsNotes/releases). Some builds are marked **pre-release**; GitHub's generic “latest” link may point to a different build. Read the selected release and its requirements.

## Choose a file

| File | Use it for |
| --- | --- |
| `subsnotes-subscription-review.zip` | Install the skill in a compatible Claude account. This is the usual web starting point. |
| `subsnotes-claude.html` | Empty-data dashboard source for a compatible private Claude Artifact. Opening it locally does not connect Gmail or storage. |
| `SubsNotes-Evidence-Reader-<version>.mcpb` | Optional local read-only access to an existing selected evidence folder. It is not needed for Claude web. |
| `SHA256SUMS.txt` | Compare the integrity hashes of that release's downloadable files. |
| GitHub source archives | Source code; not a configured account or a copy of your private data. |

## Update without losing the ledger

1. Keep the link to the existing authoritative private Artifact and close other writable copies.
2. Download the selected release's skill and enable the replacement in the host's skill settings.
3. Ask Claude: **“Update my existing private SubsNotes dashboard using this release. Preserve the same ledger, all source records, payment confirmations, history and preferences. Do not create another store.”**
4. Have the host read the current code/data revision before changing it. Use the supported guarded update path, then read back the result.
5. Reopen the same link and inspect your saved records. A skill installation alone is not proof that an existing Artifact's code was updated.

If the host cannot safely update the same private Artifact, keep the existing ledger and report the missing capability. A downloaded HTML file is not a backup of your financial data. Do not replace a newer ledger with an old snapshot to update the interface.

## Check download integrity

From the folder containing the release files, use the command for your system:

```sh
shasum -a 256 -c SHA256SUMS.txt  # macOS
sha256sum -c SHA256SUMS.txt     # Linux
```

On Windows, `Get-FileHash -Algorithm SHA256 .\subsnotes-subscription-review.zip` in PowerShell prints a hash to compare with the matching entry in `SHA256SUMS.txt`.

A matching checksum shows that your copy matches the release's listed bytes. It does not independently verify every feature, authorize a connection or make a local dataset trusted.

Keep private backups and exports outside the repository. Do not upload them to Issues or Releases. See [security and privacy](../../SECURITY.md).
