# Use SubsNotes

[English](usage.md) · [繁體中文](../zh-TW/usage.md) · [Home](../../README.md)

## First connection

1. [Download the alpha.12 skill ZIP](https://github.com/ChristimCiel/SubsNotes/releases/download/v0.2.0-alpha.12/subsnotes-subscription-review.zip), upload it to Claude's skill settings, and enable it. The [alpha.12 release page](https://github.com/ChristimCiel/SubsNotes/releases/tag/v0.2.0-alpha.12) lists its assets and checksums.
2. Connect the intended Gmail account in Claude. The native Gmail and Artifact/personal-storage capabilities must be available to your account. SubsNotes does not supply them.
3. Ask: **“Use SubsNotes to find my personal subscriptions. Keep the ledger private and show the saved dashboard in English.”**
4. Check the read-only permission request and **Only you** sharing. Keep the saved Artifact link.
5. Choose **Check Gmail**. If **Continue checking** appears, the selected search is unfinished. A completed search can still contain records needing review.

Scope matters: tell the assistant whether you want personal or business subscriptions. A customer buying from your business is not your own subscription spending.

## Understand the list

| View | What it shows |
| --- | --- |
| Subscriptions | A service list with recorded plan, renewal/access evidence, and source history. A selected month shows service-period evidence rather than an invented payment. |
| Payments | Source-recorded or user-confirmed payments allocated to the selected period. Check the provenance label. |
| Other & review | Invoices, one-time purchases, refunds and records that still need attention, across all dates. |

Choose a month without changing views. Clear the search field if a payment or service seems missing after switching views. The invoice-review button below the total opens invoices requiring payment information, across all dates. Provider and product names can differ; for example, search OpenAI as well as ChatGPT.

## Confirm and correct payments

1. Open the individual invoice or payment record.
2. Choose **Confirm payment**. Check the amount and currency against what you actually paid. A discounted or prorated invoice may differ from the standard plan price.
3. Select the precision you know:
   - **Exact date:** the actual payment date, with day, month and year.
   - **Month only:** the payment month, without an invented day.
4. Choose **Save confirmation** and wait for the saved message.

A future expected renewal is not an already-paid confirmation. Future payment dates/months are rejected; enter a date or month you can actually confirm.

**Confirmed by you** identifies your report. It does not change the source email, authenticate its sender, establish bank settlement or cancel a subscription. A month-only payment is labeled **Month confirmed · day not specified**. It contributes once to the month you confirm; it does not become a payment on the first day of that month.

Use **Edit confirmation** to correct your entry. Use **Remove confirmation** to withdraw it; this removes the user-confirmed override, not the source record or an actual payment with the provider. Original source evidence and confirmation history remain available to the processor.

If a later source disagrees, inspect both sources. Your confirmation remains a user-reported amount/date, with source conflicts shown separately; it does not turn conflicting evidence into a bank-verified payment. A new AI extraction must not silently replace your confirmation. An AI suggestion is a proposal until you explicitly confirm it. If another tab changed the ledger, reopen the latest records before retrying a save.

If you know you paid but cannot establish when, leave the date unresolved rather than selecting the invoice or email date. The record remains visible for review. You can reopen its original email or check the provider/card transaction details.

## Amounts, dates and labels

- **Original currency:** retained for every amount. An ambiguous `$` does not automatically mean USD.
- **Reference conversion:** an approximate display using dated reference rates. It is not the card issuer's historical exchange rate or fees.
- **Annual charges:** counted in full in the actual confirmed payment month, not divided by twelve.
- **Month-only confirmation:** stored as a month. It is not an exact-day transaction.
- **Invoice issue date, email date and expected renewal:** separate from a confirmed payment date.
- **Refund:** separate from gross paid amounts. A provider refund is not necessarily a bank-settled refund.
- **First source email:** the earliest observed evidence, not necessarily the subscription start date.
- **Last source read:** when the email was read, not a live provider verification.

Unconfirmed records with unknown or conflicting amounts/currencies stay visible and outside a unified total. An explicit user confirmation supplies your reported amount/currency, while disagreements with source evidence remain identifiable. An incomplete scan is not proof of zero spending or cancellation.

## Reopen and update

- **Open the saved private Artifact:** load the existing ledger. Ask **“Open my saved SubsNotes dashboard; do not create another ledger.”** if needed.
- **Refresh:** reload saved records without a Gmail search.
- **Check Gmail:** search for billing changes through the existing connection.
- **Review selected month** under **Your data & update settings:** check older billing evidence for that month.
- **Automatic refresh:** at most every fifteen minutes while the dashboard is open and visible. A hidden or closed page pauses it. Unfinished historical searches still require continuation.

Keep one writable dashboard open during edits or synchronization. Wait for storage confirmation before closing. Keep the same authoritative ledger when starting another conversation; another assistant or a new Artifact does not automatically share its data.

## Language and regional formatting

Use the **English / 繁體中文** button. The preference is saved with the same ledger. Canonical locale codes are `en` and `zh-TW`; existing `zh` preferences remain compatible.

Calendar dates retain their day or month precision, so a date-only payment is not moved to another month by a timezone conversion. Currency display follows the currency's fraction digits. The original currency, source amount and confirmation precision remain unchanged when you switch language or display currency.

## Manage a subscription

**Manage subscription** opens the provider's page. Choose the billed account, review the provider's current terms and confirm changes there. App-store purchases must be managed in the original store.

SubsNotes does not perform a provider cancellation. A payment confirmation does not enable or disable renewal. Review dates are notes in the dashboard; they do not create calendar events or deliver notifications.
