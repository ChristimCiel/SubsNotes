# SubsNotes — interactive subscription demo

A browser-local, English-language prototype for making subscription decisions before renewal. Brand names are familiar examples; **all prices, emails, terms, and dates are fictional demo data**, not current provider offers.

## Run locally

Requires Node.js 20+. No dependencies, account, API key, or build step.

```sh
npm start
```

Open http://127.0.0.1:4177 on the same computer. To choose another port, use `node server.mjs 4180`. You can also host `dist/` on any static web host. Serve it over HTTP rather than opening the HTML file directly, because it uses ES modules.

```sh
npm run check
npm test
```

## Try the main flows

1. Start at the landing page, then open the overview. Compare monthly equivalent cost, the next 12 months, categories, and items needing attention.
2. Review Notion: compare its annual bill with its monthly equivalent, record a keep/cancel decision, and optionally complete the **simulated** cancellation confirmation.
3. Review Canva: understand the monthly promotional price, the price after the discount, and remaining access under the sample terms.
4. Review GitHub: inspect the essential-service risk and **simulate** resolving the payment issue.
5. Search, filter, and sort subscriptions. Adjust reminder preferences, save them, and preview a notification.
6. Leave feedback locally and export it as JSON to share with a facilitator. Reset the demo to start again.

## Simulation boundaries

- No backend, authentication, OAuth, AI model, bank connection, inbox connection, or provider integration.
- Scanning is an animation over fixed sample records. No email is read.
- Cancellation and payment resolution change local demo state only.
- Reminder settings and previews do not schedule or send notifications.
- State and feedback stay in localStorage for this browser and origin. They are not sent to the builder.
- If browser storage is unavailable, the UI warns that a refresh may reset changes.
- The demonstration date stays fixed at **October 23, 2026** for reproducible scenarios.
- Existing saved decisions and preferences are preserved when migrating the earlier Chinese fixture to English. User-written feedback is preserved in its original language.

## What the amounts mean

- All fixture amounts are USD; there is no currency conversion.
- **Monthly equivalent:** current monthly prices plus annual prices divided by 12. This is not cash paid in the current month.
- **Next 12 months:** expected billing events during the 12 months after the fixed demo date, incorporating known discount changes and auto-renewal state. It excludes unknown usage charges and taxes and is not a payment history.
- Recording an intention to cancel does not change forecast costs. Completing simulated cancellation removes future renewals while retaining the sample access-end explanation.
- Discount face value, unused credits, and cancellation intentions are not presented as realized savings.

## Source structure

| File | Responsibility |
| --- | --- |
| `dist/data.js` | Mock scenarios and initial state |
| `dist/domain.js` | Cost calculations, filtering, state transitions, storage validation and migration |
| `dist/views.js` | Semantic HTML views and reusable components |
| `dist/app.js` | Navigation, events, forms, focus management, simulations and export |
| `dist/styles.css` | Responsive visual system and accessibility styles |
| `dist/icons.js` | Local SVG icons |
| `server.mjs` | Loopback-only development server |
| `tests/` | Calculation, state, persistence, migration and rendering checks |

Future integrations can replace the data and persistence adapters while retaining the view and calculation modules. This prototype is not a production billing or multi-tenant service.

## Feedback

Use fictional data. Feedback stays in your browser unless you choose to export and share it. No real account action is performed.
