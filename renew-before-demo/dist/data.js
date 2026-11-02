/** Illustrative fixtures, not live vendor pricing or verified commercial terms. */
export const DEMO_TODAY = '2026-10-23';
export const CATEGORIES = ['AI tools', 'Development', 'Design', 'Productivity'];

const subscriptions = [
  {
    id: 'notion', name: 'Notion', plan: 'Plus · Personal workspace', category: 'Productivity',
    logo: 'N', brand: '#262d29', amount: 96, cadence: 'annual', nextDate: '2026-10-28',
    status: 'active', autoRenew: true, essential: false, risk: 'renewal',
    description: 'Notes and project documentation. Your annual renewal is approaching—decide whether you need another year.',
    source: 'Sample email | Your annual workspace renewal', evidenceDate: '2026-10-21', promo: null,
  },
  {
    id: 'canva', name: 'Canva', plan: 'Pro · Monthly promotion', category: 'Design',
    logo: 'C', brand: '#297a86', amount: 8, cadence: 'monthly', nextDate: '2026-11-01',
    status: 'active', autoRenew: true, essential: false, risk: 'promo',
    description: 'Social graphics and presentations. This discounted month is already paid; the next monthly charge rises from $8 to $15.',
    source: 'Sample email | Your promotional pricing is ending', evidenceDate: '2026-10-22',
    promo: {
      end: '2026-11-01', regularPrice: 15, remainingCycles: 0,
      cancelPolicy: 'Sample terms: turning off auto-renewal keeps access until Nov 1. Ending access immediately would be a separate action.',
      terms: 'Fictional scenario, not a current Canva offer: $8 per month for 12 billing periods, with the final discounted period already paid. From Nov 1, the monthly price is $15. Turning off renewal prevents the next charge. Actual offers and cancellation terms depend on the account.',
    },
  },
  {
    id: 'github', name: 'GitHub', plan: 'Pro · Developer account', category: 'Development',
    logo: 'GH', brand: '#293b34', amount: 4, cadence: 'monthly', nextDate: '2026-10-25',
    status: 'active', autoRenew: true, essential: true, risk: 'payment',
    description: 'An essential part of your development workflow. A sample payment retry failed, putting paid features at risk in two days. Check the payment method.',
    source: 'Sample email | Action required: payment could not be processed', evidenceDate: '2026-10-23', promo: null,
  },
  {
    id: 'claude', name: 'Claude', plan: 'Pro · Individual', category: 'AI tools',
    logo: '✳', brand: '#a86245', amount: 20, cadence: 'monthly', nextDate: '2026-11-03',
    status: 'active', autoRenew: true, essential: false, risk: null,
    description: 'Research, writing, and coding assistance. Renews at a fixed monthly price.',
    source: 'Sample email | Your subscription receipt', evidenceDate: '2026-10-03', promo: null,
  },
  {
    id: 'figma', name: 'Figma', plan: 'Professional · 1 seat', category: 'Design',
    logo: 'F', brand: '#66548c', amount: 15, cadence: 'monthly', nextDate: '2026-11-06',
    status: 'active', autoRenew: true, essential: false, risk: null,
    description: 'Product design and collaboration. This sample account has one paid seat.',
    source: 'Sample email | Monthly subscription receipt', evidenceDate: '2026-10-06', promo: null,
  },
  {
    id: 'linear', name: 'Linear', plan: 'Basic · Personal workspace', category: 'Productivity',
    logo: 'L', brand: '#5c65a8', amount: 96, cadence: 'annual', nextDate: '2026-11-15',
    status: 'active', autoRenew: true, essential: false, risk: null,
    description: 'Product tasks and development planning. The annual fee works out to $8 per month but is billed once a year.',
    source: 'Sample email | Annual plan confirmation', evidenceDate: '2025-11-15', promo: null,
  },
  {
    id: 'google-one', name: 'Google One', plan: '200 GB · Annual', category: 'Productivity',
    logo: 'G', brand: '#4878a7', amount: 29.99, cadence: 'annual', nextDate: '2027-01-12',
    status: 'active', autoRenew: true, essential: false, risk: null,
    description: 'Storage for files and photos. The monthly equivalent is for comparison; payment is annual.',
    source: 'Sample email | Storage plan annual receipt', evidenceDate: '2026-01-12', promo: null,
  },
  {
    id: 'raycast', name: 'Raycast', plan: 'Pro · Annual', category: 'Productivity',
    logo: 'R', brand: '#b5574f', amount: 96, cadence: 'annual', nextDate: '2027-05-08',
    status: 'active', autoRenew: true, essential: false, risk: null,
    description: 'Shortcuts and everyday productivity tools. The next annual renewal is in May 2027.',
    source: 'Sample email | Pro annual subscription receipt', evidenceDate: '2026-05-08', promo: null,
  },
];

export function createInitialState() {
  return {
    version: 1,
    subscriptions: subscriptions.map((sub) => ({ ...sub, promo: sub.promo ? { ...sub.promo } : null })),
    preferences: { days: 7, email: true, weekly: true, quiet: true },
    activity: [],
    feedback: [],
  };
}
