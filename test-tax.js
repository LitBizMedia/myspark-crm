// test-tax.js
//
// Test suite for lib-aws/tax.js. Run via:
//   node test-tax.js
//
// Exits with code 0 on all pass, 1 on any failure.
// Run this BEFORE every tax-related deploy.

'use strict';

const path = require('path');
const tax = require('./lib-aws/tax');

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(label, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log('  \u2713 ' + label);
  } else {
    failed++;
    failures.push({ label, actual, expected });
    console.log('  \u2717 ' + label + '  expected=' + JSON.stringify(expected) + ' actual=' + JSON.stringify(actual));
  }
}

function group(name, fn) {
  console.log('\n' + name);
  fn();
}

// ============================================================
// getTaxSettings
// ============================================================
group('getTaxSettings()', () => {
  assertEq('null paySettings returns null',
    tax.getTaxSettings(null), null);
  assertEq('missing tax key returns null',
    tax.getTaxSettings({}), null);
  assertEq('disabled returns null',
    tax.getTaxSettings({ tax: { enabled: false, rate: 7 } }), null);
  assertEq('zero rate returns null',
    tax.getTaxSettings({ tax: { enabled: true, rate: 0 } }), null);

  const ok = tax.getTaxSettings({ tax: { enabled: true, rate: 7, label: 'GST' } });
  assertEq('enabled with rate returns object', ok !== null, true);
  assertEq('returned rate is parsed', ok.rate, 7);
  assertEq('returned label preserved', ok.label, 'GST');
  assertEq('returned label defaults', tax.getTaxSettings({ tax: { enabled: true, rate: 7 } }).label, 'Sales Tax');
});

// ============================================================
// getSectionPolicy
// ============================================================
group('getSectionPolicy()', () => {
  assertEq('missing tax: per_item default',
    tax.getSectionPolicy({}, 'services'), 'per_item');
  assertEq('missing sections: per_item default',
    tax.getSectionPolicy({ tax: { enabled: true, rate: 7 } }, 'services'), 'per_item');
  assertEq('explicit all',
    tax.getSectionPolicy({ tax: { sections: { services: 'all' } } }, 'services'), 'all');
  assertEq('explicit none',
    tax.getSectionPolicy({ tax: { sections: { products: 'none' } } }, 'products'), 'none');
  assertEq('explicit per_item',
    tax.getSectionPolicy({ tax: { sections: { sessionPacks: 'per_item' } } }, 'sessionPacks'), 'per_item');
  assertEq('garbage value falls back to per_item',
    tax.getSectionPolicy({ tax: { sections: { services: 'sometimes' } } }, 'services'), 'per_item');
});

// ============================================================
// isLineTaxable - tax disabled globally
// ============================================================
group('isLineTaxable() - tax globally disabled', () => {
  const ps = { tax: { enabled: false, rate: 7, sections: { services: 'all' } } };
  assertEq('services all but disabled: false',
    tax.isLineTaxable(ps, 'services', { taxable: true }), false);
  assertEq('products none disabled: false',
    tax.isLineTaxable(ps, 'products', { taxable: true }), false);
  assertEq('subscription disabled: false',
    tax.isLineTaxable(ps, 'subscription', { taxable: true }), false);
});

// ============================================================
// isLineTaxable - services with section policy
// ============================================================
group('isLineTaxable() - services section policy', () => {
  const allOn = { tax: { enabled: true, rate: 7, sections: { services: 'all' } } };
  const allOff = { tax: { enabled: true, rate: 7, sections: { services: 'none' } } };
  const perItem = { tax: { enabled: true, rate: 7, sections: { services: 'per_item' } } };

  assertEq('services all + taxable item: true',
    tax.isLineTaxable(allOn, 'services', { taxable: true }), true);
  assertEq('services all + non-taxable item: true (policy overrides)',
    tax.isLineTaxable(allOn, 'services', { taxable: false }), true);
  assertEq('services none + taxable item: false',
    tax.isLineTaxable(allOff, 'services', { taxable: true }), false);
  assertEq('services none + non-taxable item: false',
    tax.isLineTaxable(allOff, 'services', { taxable: false }), false);
  assertEq('services per_item + taxable: true',
    tax.isLineTaxable(perItem, 'services', { taxable: true }), true);
  assertEq('services per_item + non-taxable: false',
    tax.isLineTaxable(perItem, 'services', { taxable: false }), false);
  assertEq('services per_item + missing flag defaults true',
    tax.isLineTaxable(perItem, 'services', {}), true);
});

// ============================================================
// isLineTaxable - products and session packs follow same pattern
// ============================================================
group('isLineTaxable() - products section policy', () => {
  const ps = { tax: { enabled: true, rate: 7, sections: { products: 'all' } } };
  assertEq('products all overrides item flag',
    tax.isLineTaxable(ps, 'products', { taxable: false }), true);
});

group('isLineTaxable() - sessionPacks section policy', () => {
  const ps = { tax: { enabled: true, rate: 7, sections: { sessionPacks: 'none' } } };
  assertEq('sessionPacks none overrides item flag',
    tax.isLineTaxable(ps, 'sessionPacks', { taxable: true }), false);
});

// ============================================================
// isLineTaxable - subscriptions follow section policy (Stage 3+)
// ============================================================
group('isLineTaxable() - subscription section policy', () => {
  const subAll = { tax: { enabled: true, rate: 7, sections: { subscription: 'all' } } };
  const subNone = { tax: { enabled: true, rate: 7, sections: { subscription: 'none' } } };
  const subPerItem = { tax: { enabled: true, rate: 7, sections: { subscription: 'per_item' } } };

  assertEq('subscription all + taxable item: true',
    tax.isLineTaxable(subAll, 'subscription', { taxable: true }), true);
  assertEq('subscription all + non-taxable item: true (policy overrides)',
    tax.isLineTaxable(subAll, 'subscription', { taxable: false }), true);
  assertEq('subscription none + taxable item: false',
    tax.isLineTaxable(subNone, 'subscription', { taxable: true }), false);
  assertEq('subscription per_item + taxable: true',
    tax.isLineTaxable(subPerItem, 'subscription', { taxable: true }), true);
  assertEq('subscription per_item + non-taxable: false',
    tax.isLineTaxable(subPerItem, 'subscription', { taxable: false }), false);
  assertEq('subscription missing policy defaults to per_item with taxable: true',
    tax.isLineTaxable({ tax: { enabled: true, rate: 7 } }, 'subscription', { taxable: true }), true);
});

// appointmentType now follows section policy (like services/products/etc.)
group('isLineTaxable() - appointmentType section policy', () => {
  const atAll = { tax: { enabled: true, rate: 7, sections: { appointmentType: 'all' } } };
  const atNone = { tax: { enabled: true, rate: 7, sections: { appointmentType: 'none' } } };
  const atPerItem = { tax: { enabled: true, rate: 7, sections: { appointmentType: 'per_item' } } };

  assertEq('appointmentType all + taxable: true',
    tax.isLineTaxable(atAll, 'appointmentType', { taxable: true }), true);
  assertEq('appointmentType all + non-taxable: true (policy overrides)',
    tax.isLineTaxable(atAll, 'appointmentType', { taxable: false }), true);
  assertEq('appointmentType none + taxable: false',
    tax.isLineTaxable(atNone, 'appointmentType', { taxable: true }), false);
  assertEq('appointmentType per_item + taxable: true',
    tax.isLineTaxable(atPerItem, 'appointmentType', { taxable: true }), true);
  assertEq('appointmentType per_item + non-taxable: false',
    tax.isLineTaxable(atPerItem, 'appointmentType', { taxable: false }), false);
  assertEq('appointmentType missing policy defaults to per_item',
    tax.isLineTaxable({ tax: { enabled: true, rate: 7 } }, 'appointmentType', { taxable: true }), true);
});

// ============================================================
// isLineTaxable - locked non-taxable sections
// ============================================================
group('isLineTaxable() - locked non-taxable sections', () => {
  const everythingOn = {
    tax: {
      enabled: true, rate: 7,
      sections: { services: 'all', products: 'all', sessionPacks: 'all' }
    }
  };
  assertEq('giftCard always false even with taxable:true',
    tax.isLineTaxable(everythingOn, 'giftCard', { taxable: true }), false);
  assertEq('tip always false',
    tax.isLineTaxable(everythingOn, 'tip', { taxable: true }), false);
  assertEq('fee always false',
    tax.isLineTaxable(everythingOn, 'fee', { taxable: true }), false);
  assertEq('credit always false',
    tax.isLineTaxable(everythingOn, 'credit', { taxable: true }), false);
});

// ============================================================
// isLineTaxable - POS custom items
// ============================================================
group('isLineTaxable() - POS custom items', () => {
  const ps = { tax: { enabled: true, rate: 7 } };
  assertEq('pos with taxable:true returns true',
    tax.isLineTaxable(ps, 'pos', { taxable: true }), true);
  assertEq('pos with taxable:false returns false',
    tax.isLineTaxable(ps, 'pos', { taxable: false }), false);
  assertEq('pos with missing flag defaults true',
    tax.isLineTaxable(ps, 'pos', {}), true);
});

// ============================================================
// defaultPosTaxable
// ============================================================
group('defaultPosTaxable()', () => {
  assertEq('null paySettings defaults true',
    tax.defaultPosTaxable(null), true);
  assertEq('missing flag defaults true',
    tax.defaultPosTaxable({ tax: { enabled: true, rate: 7 } }), true);
  assertEq('explicit true returns true',
    tax.defaultPosTaxable({ tax: { posDefaultTaxable: true } }), true);
  assertEq('explicit false returns false',
    tax.defaultPosTaxable({ tax: { posDefaultTaxable: false } }), false);
});

// ============================================================
// normalizeTaxSettings
// ============================================================
group('normalizeTaxSettings()', () => {
  const empty = tax.normalizeTaxSettings(null);
  assertEq('null input enabled false', empty.enabled, false);
  assertEq('null input label defaults', empty.label, 'Sales Tax');
  assertEq('null input rate 0', empty.rate, 0);
  assertEq('null input services per_item', empty.sections.services, 'per_item');
  assertEq('null input products per_item', empty.sections.products, 'per_item');
  assertEq('null input sessionPacks per_item', empty.sections.sessionPacks, 'per_item');
  assertEq('null input subscription per_item', empty.sections.subscription, 'per_item');
  assertEq('null input appointmentType per_item', empty.sections.appointmentType, 'per_item');
  assertEq('null input pos default true', empty.posDefaultTaxable, true);

  const partial = tax.normalizeTaxSettings({
    enabled: true, rate: '7.5', label: 'GST',
    sections: { services: 'all' }
  });
  assertEq('partial input rate parsed', partial.rate, 7.5);
  assertEq('partial input services preserved', partial.sections.services, 'all');
  assertEq('partial input products defaults', partial.sections.products, 'per_item');
  assertEq('partial input sessionPacks defaults', partial.sections.sessionPacks, 'per_item');
  assertEq('partial input subscription defaults', partial.sections.subscription, 'per_item');
  assertEq('partial input appointmentType defaults', partial.sections.appointmentType, 'per_item');
});

// ============================================================
// Backward compatibility: pre-existing data with no sections key
// ============================================================
group('Backward compatibility (pre-migration shape)', () => {
  const legacy = { tax: { enabled: true, rate: 7, label: 'Sales Tax' } };

  assertEq('legacy services + taxable item: true',
    tax.isLineTaxable(legacy, 'services', { taxable: true }), true);
  assertEq('legacy services + non-taxable item: false',
    tax.isLineTaxable(legacy, 'services', { taxable: false }), false);
  assertEq('legacy products + missing flag: true',
    tax.isLineTaxable(legacy, 'products', {}), true);
  assertEq('legacy sessionPacks + taxable: true',
    tax.isLineTaxable(legacy, 'sessionPacks', { taxable: true }), true);
  assertEq('legacy subscription + taxable: true (per_item default)',
    tax.isLineTaxable(legacy, 'subscription', { taxable: true }), true);
  assertEq('legacy subscription + non-taxable: false (per_item default)',
    tax.isLineTaxable(legacy, 'subscription', { taxable: false }), false);
  assertEq('legacy giftCard + taxable: still false',
    tax.isLineTaxable(legacy, 'giftCard', { taxable: true }), false);
});

// ============================================================
// Summary
// ============================================================
console.log('\n' + '='.repeat(50));
console.log('Passed: ' + passed);
console.log('Failed: ' + failed);
console.log('='.repeat(50));

if (failed > 0) {
  console.log('\nFAILURES:');
  failures.forEach(f => {
    console.log('  ' + f.label);
    console.log('    expected: ' + JSON.stringify(f.expected));
    console.log('    actual:   ' + JSON.stringify(f.actual));
  });
  process.exit(1);
}

console.log('\nAll tests passed.');
process.exit(0);
