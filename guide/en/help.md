# FAQ & troubleshooting

[English](help.md) · [繁體中文](../zh-TW/help.md) · [Home](../../README.md)

## Can I try it without connecting Gmail?

Yes. The [hosted demo](https://christimciel.github.io/SubsNotes/confirmations.html) and local sample use fictional data. They do not discover your subscriptions or send notifications.

## Is SubsNotes free?

The project is free under MIT. The Claude web experience still requires your own eligible Claude capabilities and uses that account's limits. SubsNotes does not provide a paid Claude account or API credits. The local fictional sample needs no account.

## Why is an invoice not counted as a payment?

An invoice amount or issue date does not by itself establish when it was paid. Open the source or use **Confirm payment** to report what you know. Choose an exact day or only a month. Your report is labeled separately from source evidence and bank reconciliation. Unknown information stays visible rather than becoming zero spending.

## I paid, but I do not know the exact day

Choose **Month only** if you can confirm the month. Do not use an invoice date, email arrival date, card-bill month or repayment due date as a substitute. If the month is also unknown, keep the record unresolved until you have a transaction date or can explicitly confirm it.

## I cannot see a payment or service

1. Clear search text and check the current view and month.
2. Open the invoice-review button for records across all dates.
3. Search the provider name as well as the product name.
4. Check whether discovery is unfinished or the source needs review.
5. Open the original source before changing fields.

A partial query is not a full mailbox audit. Receipt extraction can miss unfamiliar formats or languages even after a search completes.

## My panel is blank or says it took too long to load

Open the same saved Artifact in your usual signed-in browser and retry once. Confirm that the account still has the required native capabilities. Ask for a dated plain chat table if the renderer remains unavailable. Do not create a replacement ledger or grant broader access merely to display existing data. Generating HTML does not prove the host rendered it.

## Saving failed or another tab changed the records

Keep the original page/data. Close other writable copies, reopen the same private Artifact, inspect the latest saved confirmation, then retry the intended edit. Wait for the saved message. If storage confirmation is uncertain, do not repeatedly submit stale data or replace the ledger with an older export.

## Will AI change a payment I confirmed?

The supported source-update paths preserve user confirmations and original source evidence. Use **Edit confirmation** for an intentional correction, or **Remove confirmation** to withdraw it. AI-extracted information is not a user confirmation. Keep one writable dashboard open; an unsupported whole-ledger replacement or host storage failure is outside a normal rescan.

## Why can the assistant not read a receipt attachment?

The host must actually support attachment/document access. Metadata or a link is not document content. An encrypted PDF may require you to unlock it locally. Supply only the relevant receipt/transaction lines when appropriate; do not share a national ID, full card number, bank password or PDF password. A successful Gmail connection does not unlock protected documents or grant provider-account access.

## Do review dates notify me? Does closing the page keep scanning?

No. Review dates are saved notes. The Claude dashboard does not send notifications, and its automatic Gmail checks pause while hidden or closed. A separately configured host schedule or local process must be authorized and tested independently.

## Can it cancel subscriptions for me?

No. **Manage subscription** opens a provider page. Review and confirm changes with that provider or the original app store. A dashboard status or confirmation does not change provider billing.

## Can ChatGPT open my Claude ledger automatically?

No. The stores are separate. Use an explicitly supplied private export or supported local dataset. A generated visual is a snapshot, not shared storage or a live synchronization connection.

## Can SubsNotes be used commercially?

Yes. [MIT](../../LICENSE) permits commercial use, modification, redistribution, sublicensing and sale under its conditions. Keep the copyright and license notices. This applies to the project owner and third parties; public access is not a noncommercial restriction. See the [OSI MIT text](https://opensource.org/license/mit) and [Choose a License MIT summary](https://choosealicense.com/licenses/mit/).

Contributors retain copyright. MIT permission does not make another person's contribution exclusively yours, and a later licensing decision does not retract permission already granted for existing MIT copies. Service names, trademarks, artwork and dependencies keep their own rights/notices; code licensing is not endorsement or blanket image permission.

## How do I report a problem safely?

Use a public Issue with a fictional reproduction, expected/actual behavior, version, language and host/browser. Do not include real bills or private links. For vulnerabilities or sensitive data, follow [SECURITY.md](../../SECURITY.md) and use private reporting.
