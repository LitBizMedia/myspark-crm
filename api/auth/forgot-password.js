// api/auth/forgot-password.js
//
// Handles password reset requests for agency users and subaccount users.
// Generates a secure token, stores it, sends a reset email via Resend.
//
// Always returns success to prevent email enumeration attacks.
//
// Token storage in password_reset_tokens table:
//   user_type: 'agency' | 'subaccount_user'
//   user_identifier: agency_user.id (uuid) | subaccount_user.id (uuid) | 'subId:username' (legacy fallback)
//   subaccount_slug: only set for subaccount resets
//   email, expires_at
//
// Subaccount lookup priority:
//   1. subaccount_users table (the new auth system uses this)
//   2. subaccounts.admin_email (legacy: subaccount where admin only exists in JSON blob)
//
// reset-password.js handles both identifier formats.

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const APP_URL = process.env.APP_URL || 'https://mysparkplus.app';
const FROM_EMAIL = 'noreply@mysparkplus.app';
const TOKEN_EXPIRY_MINUTES = 60;

function sbHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, context, slug } = req.body || {};
  if (!email || !context) {
    return res.status(400).json({ error: 'email and context required' });
  }
  if (['agency', 'subaccount'].indexOf(context) < 0) {
    return res.status(400).json({ error: 'context must be agency or subaccount' });
  }

  const lowerEmail = String(email).toLowerCase();

  // Always return success to prevent email enumeration
  const safeReturn = function() {
    return res.status(200).json({
      success: true,
      message: 'If that email is on file, a reset link is on its way.'
    });
  };

  try {
    let userType = null;
    let userIdentifier = null;
    let subaccountSlug = slug || null;
    let userName = '';

    if (context === 'agency') {
      // ── Agency user lookup by email ──
      const r = await fetch(
        SUPABASE_URL + '/rest/v1/agency_users?email=eq.' + encodeURIComponent(lowerEmail) + '&active=eq.true&select=id,name,email',
        { headers: sbHeaders() }
      );
      if (!r.ok) return safeReturn();
      const rows = await r.json();
      if (!rows || !rows.length) return safeReturn();
      userType = 'agency';
      userIdentifier = rows[0].id;
      userName = rows[0].name || '';

    } else {
      // ── Subaccount user lookup by email ──
      if (!slug) return safeReturn();
      const subId = 'sub-' + slug;

      // 1. Try subaccount_users table first (new auth system)
      try {
        const r = await fetch(
          SUPABASE_URL + '/rest/v1/subaccount_users'
          + '?subaccount_id=eq.' + encodeURIComponent(subId)
          + '&email=eq.' + encodeURIComponent(lowerEmail)
          + '&active=eq.true'
          + '&select=id,username,display_name,email',
          { headers: sbHeaders() }
        );
        if (r.ok) {
          const rows = await r.json();
          if (rows && rows.length) {
            userType = 'subaccount_user';
            userIdentifier = rows[0].id;
            userName = rows[0].display_name || rows[0].username || '';
          }
        }
      } catch (e) { /* fall through to legacy lookup */ }

      // 2. Legacy fallback: check subaccounts.admin_email
      // This catches subaccounts where the admin only exists in the JSON blob
      // and was never migrated to subaccount_users. The reset will create
      // the row when the user clicks the link.
      if (!userType) {
        try {
          const r = await fetch(
            SUPABASE_URL + '/rest/v1/subaccounts'
            + '?id=eq.' + encodeURIComponent(subId)
            + '&admin_email=eq.' + encodeURIComponent(lowerEmail)
            + '&select=id,name,admin_username,admin_email',
            { headers: sbHeaders() }
          );
          if (r.ok) {
            const rows = await r.json();
            if (rows && rows.length && rows[0].admin_username) {
              userType = 'subaccount_user';
              // Composite identifier: subId:username. reset-password.js will
              // look up or create the subaccount_users row when this format
              // is detected.
              userIdentifier = subId + ':' + rows[0].admin_username;
              userName = rows[0].name || rows[0].admin_username || '';
            }
          }
        } catch (e) { /* swallow - safe return below */ }
      }

      if (!userType) return safeReturn();
    }

    // ── Generate token, store, email ──
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MINUTES * 60000).toISOString();

    const rToken = await fetch(SUPABASE_URL + '/rest/v1/password_reset_tokens', {
      method: 'POST',
      headers: sbHeaders({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify({
        token: token,
        user_type: userType,
        user_identifier: userIdentifier,
        subaccount_slug: subaccountSlug,
        email: lowerEmail,
        expires_at: expiresAt
      })
    });

    if (!rToken.ok) {
      console.error('forgot-password: token store failed', await rToken.text());
      return safeReturn();
    }

    // Build reset link
    const resetPath = (context === 'agency') ? '/agency' : '/' + slug;
    const resetLink = APP_URL + resetPath + '?reset=' + token;

    // Send via Resend
    const html = '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#1a1030">'
      + '<h2 style="color:#6b21ea;margin:0 0 8px">Reset your password</h2>'
      + '<p style="margin:0 0 20px;color:#5a4d7a;font-size:15px">Hi' + (userName ? ' ' + userName : '') + ', we received a request to reset your MySpark+ password.</p>'
      + '<a href="' + resetLink + '" style="display:inline-block;background:#6b21ea;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:15px;margin-bottom:20px">Reset Password</a>'
      + '<p style="font-size:13px;color:#5a4d7a;margin:0 0 8px">This link expires in ' + TOKEN_EXPIRY_MINUTES + ' minutes. If you did not request this, ignore this email.</p>'
      + '<p style="font-size:12px;color:#9b8ec4;margin:0">MySpark+ by LitBiz Media</p>'
      + '</div>';

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'MySpark+ <' + FROM_EMAIL + '>',
        to: [lowerEmail],
        subject: 'Reset your MySpark+ password',
        html: html
      })
    });

    return safeReturn();

  } catch (e) {
    console.error('forgot-password error:', e);
    return safeReturn();
  }
};
