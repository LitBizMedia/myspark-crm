// lib-aws/tax.js
//
// Canonical tax policy helper. Encodes the three-tier section policy:
//   1. Global switch (paySettings.tax.enabled + rate)
//   2. Section policy ('all' | 'none' | 'per_item')
//   3. Per-item taxable flag (fallback when section is 'per_item')
//
// This module is the single source of truth. The frontend mirror in
// index.html (isLineTaxable) must match this logic exactly.
//
// MUST stay in sync with the frontend helper at index.html.

'use strict';

// Sections that participate in section policy.
const POLICY_SECTIONS = ['services', 'products', 'sessionPacks', 'subscription', 'appointmentType'];

// Sections that are ALWAYS per-item (no section policy applies).
const PER_ITEM_ONLY_SECTIONS = [];

// Sections that are ALWAYS non-taxable (locked off, no UI).
const LOCKED_NON_TAXABLE_SECTIONS = ['giftCard', 'tip', 'fee', 'credit'];

// Default policy when paySettings.tax.sections is missing or partial.
const DEFAULT_POLICY = 'per_item';

// Default for POS custom items at creation time.
const DEFAULT_POS_TAXABLE = true;

/**
 * Returns the resolved tax settings object, or null if tax collection
 * is effectively disabled. Mirrors getTaxSettings() in index.html.
 *
 * @param {object} paySettings - The subaccount paySettings object.
 * @returns {object|null} { enabled, rate, label, sections, posDefaultTaxable } or null.
 */
function getTaxSettings(paySettings) {
  const t = paySettings && paySettings.tax;
  if (!t || !t.enabled) return null;
  const rate = parseFloat(t.rate) || 0;
  if (rate <= 0) return null;
  return {
    enabled: true,
    rate: rate,
    label: t.label || 'Sales Tax',
    sections: t.sections || {},
    posDefaultTaxable: t.posDefaultTaxable !== false
  };
}

/**
 * Returns the policy for a given section: 'all', 'none', or 'per_item'.
 * Defaults to 'per_item' when section policy is missing.
 *
 * @param {object} paySettings - The subaccount paySettings object.
 * @param {string} section - 'services' | 'products' | 'sessionPacks'.
 * @returns {string} 'all' | 'none' | 'per_item'
 */
function getSectionPolicy(paySettings, section) {
  const t = paySettings && paySettings.tax;
  if (!t || !t.sections) return DEFAULT_POLICY;
  const v = t.sections[section];
  if (v === 'all' || v === 'none' || v === 'per_item') return v;
  return DEFAULT_POLICY;
}

/**
 * The core decision: should this line item be taxed?
 * Encodes the three-tier logic in one place.
 *
 * @param {object} paySettings - The subaccount paySettings object.
 * @param {string} section - 'services' | 'products' | 'sessionPacks' |
 *                           'subscription' | 'appointmentType' |
 *                           'giftCard' | 'tip' | 'fee' | 'credit' | 'pos'
 * @param {object} item - Line item with optional .taxable flag.
 * @returns {boolean}
 */
function isLineTaxable(paySettings, section, item) {
  // Tier 0: tax collection disabled entirely
  if (!getTaxSettings(paySettings)) return false;

  // Locked off: gift card sales, tips, fees, credits
  if (LOCKED_NON_TAXABLE_SECTIONS.indexOf(section) !== -1) return false;

  // Pure per-item: subscriptions, appointment types
  if (PER_ITEM_ONLY_SECTIONS.indexOf(section) !== -1) {
    return !!(item && item.taxable !== false);
  }

  // POS custom items: always treated as per-item (staff toggles per line)
  if (section === 'pos') {
    return !!(item && item.taxable !== false);
  }

  // Section-policy-driven: services, products, sessionPacks
  if (POLICY_SECTIONS.indexOf(section) !== -1) {
    const policy = getSectionPolicy(paySettings, section);
    if (policy === 'all') return true;
    if (policy === 'none') return false;
    // per_item
    return !!(item && item.taxable !== false);
  }

  // Unknown section: conservative default. Fall back to per-item.
  return !!(item && item.taxable !== false);
}

/**
 * Default taxable flag for a NEW POS custom item at creation time.
 * Honors paySettings.tax.posDefaultTaxable (defaults true).
 *
 * @param {object} paySettings - The subaccount paySettings object.
 * @returns {boolean}
 */
function defaultPosTaxable(paySettings) {
  const t = paySettings && paySettings.tax;
  if (!t) return DEFAULT_POS_TAXABLE;
  return t.posDefaultTaxable !== false;
}

/**
 * Normalize a paySettings.tax object on read. Fills in safe defaults
 * for the new fields without mutating the input.
 *
 * @param {object} tax - Raw tax settings.
 * @returns {object} Normalized { enabled, label, rate, sections, posDefaultTaxable }.
 */
function normalizeTaxSettings(tax) {
  const t = tax || {};
  return {
    enabled: !!t.enabled,
    label: t.label || 'Sales Tax',
    rate: parseFloat(t.rate) || 0,
    sections: {
      services: (t.sections && t.sections.services) || DEFAULT_POLICY,
      products: (t.sections && t.sections.products) || DEFAULT_POLICY,
      sessionPacks: (t.sections && t.sections.sessionPacks) || DEFAULT_POLICY,
      subscription: (t.sections && t.sections.subscription) || DEFAULT_POLICY,
      appointmentType: (t.sections && t.sections.appointmentType) || DEFAULT_POLICY
    },
    posDefaultTaxable: t.posDefaultTaxable !== false
  };
}

module.exports = {
  getTaxSettings,
  getSectionPolicy,
  isLineTaxable,
  defaultPosTaxable,
  normalizeTaxSettings,
  POLICY_SECTIONS,
  PER_ITEM_ONLY_SECTIONS,
  LOCKED_NON_TAXABLE_SECTIONS,
  DEFAULT_POLICY,
  DEFAULT_POS_TAXABLE
};
