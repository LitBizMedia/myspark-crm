// lib-aws/html-sanitize.js
// Server-side HTML sanitization for contract bodies and other rich text.
// Mirrors the frontend rteCleanHtml allowlist for defense in depth.
//
// See docs/MySpark-Contracts-Spec.md

const sanitizeHtml = require('sanitize-html');

const DEFAULT_OPTIONS = {
  allowedTags: [
    'p', 'br', 'div', 'span',
    'b', 'strong', 'i', 'em', 'u', 's', 'strike',
    'h1', 'h2', 'h3',
    'ul', 'ol', 'li',
    'a'
  ],
  allowedAttributes: {
    'a': ['href', 'target', 'rel']
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  // Force safe defaults on anchors. Bad schemes drop the href entirely.
  transformTags: {
    'a': function(tagName, attribs) {
      const href = attribs.href || '';
      if (!/^(https?:\/\/|mailto:)/i.test(href)) {
        return { tagName: 'a', attribs: {} };
      }
      return {
        tagName: 'a',
        attribs: {
          href: href,
          target: '_blank',
          rel: 'noopener noreferrer'
        }
      };
    }
  }
};

/**
 * Sanitize HTML for safe storage in envelope body snapshots.
 * Returns cleaned HTML. Empty or invalid input returns ''.
 */
function sanitize(html) {
  if (!html || typeof html !== 'string') return '';
  return sanitizeHtml(html, DEFAULT_OPTIONS);
}

module.exports = {
  sanitize,
  DEFAULT_OPTIONS
};
