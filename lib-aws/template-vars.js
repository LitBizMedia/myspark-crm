// lib-aws/template-vars.js
// Variable substitution for contracts, emails, and other templated content.
// Convention: {{snake_case_token}}, flat namespace, {{custom:field_key}} for
// custom field passthrough.
//
// Future: buildContractContext() helper for assembling the standard context
// object from contact + subaccount + appointment data. Added in Step 3 when
// contracts-send needs it.
//
// See docs/MySpark-Contracts-Spec.md

const TOKEN_PATTERN = /\{\{([a-z_][a-z0-9_]*(?::[a-z_][a-z0-9_]*)?)\}\}/gi;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Substitute {{tokens}} in html using values from context.
 *
 * @param {string} html - Template string with {{tokens}}
 * @param {object} context - Map of token -> value
 * @param {object} [opts]
 * @param {boolean} [opts.escape=true] - HTML-escape substituted values.
 *                                       Set false for plain text contexts (SMS).
 * @returns {object} { html, used, missing, snapshot }
 *   html:     rendered output
 *   used:     array of unique tokens that were substituted
 *   missing:  array of unique tokens in template but not in context
 *   snapshot: object of token -> value for legal record
 */
function resolveTemplate(html, context, opts) {
  opts = opts || {};
  const shouldEscape = opts.escape !== false;
  context = context || {};

  const used = new Set();
  const missing = new Set();
  const snapshot = {};

  const result = String(html || '').replace(TOKEN_PATTERN, function(match, token) {
    const key = token.toLowerCase();

    if (context[key] !== undefined && context[key] !== null) {
      used.add(key);
      snapshot[key] = context[key];
      const value = String(context[key]);
      return shouldEscape ? escapeHtml(value) : value;
    }

    missing.add(key);
    return match;
  });

  return {
    html: result,
    used: Array.from(used),
    missing: Array.from(missing),
    snapshot: snapshot
  };
}

module.exports = {
  resolveTemplate,
  escapeHtml,
  TOKEN_PATTERN
};
