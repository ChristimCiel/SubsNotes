# SubsNotes v1 MVP

**Built for OPEN LAB 2026 AI Build Challenge**  
Deadline: 2026-11-27 23:59:59 Taipei

## Product Concept

A closed-loop AI agent for AI power users that manages subscriptions within a monthly budget.

**The Loop:** Detect → Judge → User Approves → Execute → Verify → Record

**Positioning:** Reduce decision fatigue and the number of decisions, not just save time.

**Pricing (shown in product):** US$30/month

**Important:** ALL data is fictional/virtual. No real accounts, real merchants, real money, or real subscriptions.

## Features Implemented ✅

### Core System
- ✅ **Ed25519 Signature Verification** - Local agent bridge with tamper-proof signed receipts
- ✅ **Budget Envelope System** - Monthly budget with allocation, spend, remaining capacity
- ✅ **Recommendation Engine** - Keep/downgrade/cancel with AI-powered reasons
- ✅ **Mandate & Approval System** - Explicit user approval with scope, merchant, action, limits, expiry
- ✅ **Append-Only Audit Log** - Full traceability

### Recommendations
- ✅ Price increase detection
- ✅ Free trial expiry guard
- ✅ Usage-based recommendations
- ✅ Duplicate service detection
- ✅ Budget impact analysis

### Execution Tiers
- ✅ **T0:** Deep-link catalog (Apple, Google Play, LINE Pay, 全支付, 街口)
- ✅ **T1:** Supervised step-by-step (conceptual)
- ✅ **T2:** Autonomous Playwright executor with Claude API + offline replay

### UI & Demo
- ✅ Main dashboard with budget visualization
- ✅ Judge mode with one-click guided demo
- ✅ Fictional merchant site with realistic dark patterns:
  - Retention offers ("50% off for 3 months!")
  - Confirmshaming ("Yes, I want to lose all these benefits")
  - Hidden cancel link
  - User-present 2FA flow
- ✅ Traditional Chinese + English UI

### Security
- ✅ Ed25519 signatures prevent tampering
- ✅ Field allowlist (merchant, amount, currency, date)
- ✅ Prompt injection detection
- ✅ No password storage (login/2FA are user-present)
- ✅ Complete audit trail

### Tests
- ✅ **65 Passing Unit Tests** covering all deterministic logic
- ✅ **3 E2E Playwright Tests** for fictional merchant and judge mode
- ✅ **Offline replay mode** for CI and judges (no ANTHROPIC_API_KEY needed)

## Quick Start

### Prerequisites
- Node.js 22+
- npm

### Installation

```bash
cd subsnotes-v1
npm install
npx playwright install chromium
```

### Run Tests

```bash
# Unit tests (65 tests, ~100ms)
npm test

# E2E tests (requires dev server running)
npm run test:e2e
```

### Start Dev Server

```bash
npm run dev
```

Then visit:
- **Main UI:** http://127.0.0.1:4199
- **Judge Mode:** http://127.0.0.1:4199/judge.html
- **Fictional Merchant:** http://127.0.0.1:4199/fictional-merchant.html

### Judge Mode (For Competition Judges)

The judge mode is a **one-click demonstration** that runs completely offline:

1. Visit http://127.0.0.1:4199/judge.html
2. Click "🚀 Run Complete Demo"
3. Watch the full loop execute in ~3 seconds
4. Toggle language with the button in top-right corner

**No ANTHROPIC_API_KEY required!** All LLM interactions use pre-recorded offline replays.

## Project Structure

```
subsnotes-v1/
├── src/
│   ├── budget.mjs           # Budget envelope system
│   ├── crypto.mjs           # Ed25519 signature verification
│   ├── recommendations.mjs  # AI recommendation engine
│   ├── mandates.mjs         # Mandate & approval system
│   ├── executor.mjs         # T2 Playwright executor
│   ├── judge-mode.mjs       # Judge demo orchestrator
│   └── server.mjs           # Dev server
├── public/
│   ├── index.html           # Main dashboard UI
│   ├── judge.html           # Judge mode demo
│   └── fictional-merchant.html  # Demo cancellation site
├── tests/
│   ├── crypto.test.mjs      # Signature tests (13 tests)
│   ├── budget.test.mjs      # Budget tests (17 tests)
│   ├── recommendations.test.mjs  # Recommendation tests (16 tests)
│   ├── mandates.test.mjs    # Mandate tests (19 tests)
│   └── e2e/
│       └── fictional-merchant.spec.mjs  # E2E tests (3 tests)
├── fixtures/
│   └── replays/
│       └── fictional-merchant-cancel.json  # Offline replay
└── package.json
```

## Technical Stack

- **Runtime:** Node.js 22+ (native test runner, Web Crypto API)
- **LLM:** Anthropic Claude 3.5 Sonnet (via SDK)
- **Automation:** Playwright (for T2 execution)
- **UI:** Vanilla HTML/CSS/JS (no framework overhead)
- **Crypto:** Ed25519 via Web Crypto API
- **Testing:** Node.js test runner + Playwright Test

## How It Works

### 1. Local Agent Bridge (Ed25519)

The user's local AI agent (Claude Desktop, Cursor skill, or MCP) reads receipts locally and sends only a **signed summary**:

```json
{
  "data": {
    "merchant": "Netflix",
    "amount": 15.99,
    "currency": "USD",
    "date": "2026-11-25"
  },
  "signature": "base64-encoded-ed25519-signature",
  "publicKey": "base64-encoded-public-key"
}
```

The server verifies the signature, validates the schema, and rejects tampering or prompt injection attempts.

### 2. Budget & Recommendations

The system:
- Tracks monthly budget allocation
- Calculates spend and remaining capacity
- Generates AI recommendations based on:
  - Price changes
  - Trial expiry
  - Usage patterns
  - Budget impact

### 3. Mandate & Approval

Before ANY action, the user must approve a mandate with:
- Scope (single/recurring/category)
- Merchant
- Action (keep/downgrade/cancel)
- Max amount
- Expiry date

All mandates are logged in an append-only audit log.

### 4. T2 Execution (Autonomous)

For supported merchants (fictional demo site), the agent:
- Uses Playwright to automate browser interactions
- Gets guidance from Claude API (or offline replay)
- Handles dark patterns (retention offers, confirmshaming)
- Stops at payment forms or unknown pages
- Verifies cancellation from page state
- Records confirmation ID

### 5. Offline Replay

Successful T2 executions are recorded as JSON traces. In offline mode (no ANTHROPIC_API_KEY), the executor replays these traces exactly, making the demo work for CI and judges.

## Security Features

### Input Validation
- **Field Allowlist:** Only whitelisted fields accepted
- **Schema Validation:** Type and format checking
- **Prompt Injection Detection:** Rejects suspicious patterns

### Cryptographic Verification
- **Ed25519 Signatures:** 256-bit elliptic curve signatures
- **Canonical JSON:** Sorted keys, deterministic serialization
- **Tamper Detection:** Any modification invalidates signature

### Safe Execution
- **No Credential Storage:** Passwords never stored
- **User-Present Auth:** Login and 2FA require user interaction
- **Payment Form Guards:** Executor stops at payment screens
- **Mandate Limits:** Actions constrained by approved scope

## Known Limitations

1. **Fictional Data Only:** All subscriptions, amounts, and merchants are fake
2. **Apple/Google Play:** Deep-link only (T0 tier)
3. **T2 Demo Scope:** Only fictional merchant site in this MVP
4. **No Real Payments:** This is a demonstration, not a production billing system
5. **No ComPDF Integration:** Out of scope for v1

## CI Requirements

The CI environment needs:
- Node.js 22+
- Playwright installed
- **No ANTHROPIC_API_KEY** (uses offline replay)

Tests run in ~400ms + E2E tests in ~5-10s.

## What Tim Needs to Do

1. ✅ **Review this PR** - https://github.com/ChristimCiel/SubsNotes/pull/2
2. ⏳ **Add ANTHROPIC_API_KEY** as a GitHub secret (optional, for recording new replays)
3. ⏳ **Test judge mode** at http://127.0.0.1:4199/judge.html
4. ⏳ **Provide feedback** before next review checkpoint

## Screenshots

Coming soon - will be added before final submission.

## Competition Notes

**Rubric:**
- Creativity: 30 points
- Implementation: 30 points
- AI Use: 20 points
- Presentation: 20 points

**Differentiators:**
- Closed-loop architecture (detect → judge → approve → execute → verify → record)
- Security-first design (Ed25519 signatures, prompt injection prevention)
- Offline capability (works without API key)
- Realistic dark pattern handling
- Complete audit trail
- Bilingual UI (English + Traditional Chinese)

## License

MIT (same as parent project)
