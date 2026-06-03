// api/auth/forgot-password.js (Lambda version)
//
// POST /api/auth/forgot-password
//
// Generates a secure token, stores it, sends a reset email via Mailgun.
// Always returns success to prevent email enumeration attacks.
//
// MIGRATED:
//   Supabase REST → lib/db.js (Apr 30)
//   Resend inline fetch → lib/mailgun.js (May 17)

const db = require('./lib/db');
const { sendEmail } = require('./lib/mailgun');
const { wrap } = require('./lib/lambda-adapter');
const crypto = require('crypto');

const APP_URL = process.env.APP_URL || 'https://mysparkplus.app';
const TOKEN_EXPIRY_MINUTES = 60;

async function handler(req, res) {
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

  // Always returns 200 to prevent email enumeration
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
      // /agency portal removed (Phase 4C, May 30 2026). Agency users must
      // now reset their password through the LitBiz workspace subaccount path.
      return safeReturn();
    } else {
      if (!slug) return safeReturn();
      const subId = 'sub-' + slug;

      try {
        const u = await db.findOne('subaccount_users',
          { subaccount_id: subId, email: lowerEmail, active: true },
          { select: 'id, username, display_name, email' }
        );
        if (u) {
          userType = 'subaccount_user';
          userIdentifier = u.id;
          userName = u.display_name || u.username || '';
        }
      } catch (e) {
        console.warn('forgot-password: subaccount_users lookup failed:', e.message);
      }

      // Legacy subaccounts.admin_username fallback removed (Jun 2026).
      // All admins live in subaccount_users post May 2 migration; the
      // primary lookup above covers them. The old fallback issued
      // composite 'subId:username' tokens that reset-password could turn
      // into brand-new admin rows, a provisioning path inside a reset
      // endpoint. Cut it. Unknown emails now fall straight through to the
      // enumeration-safe response.
      if (!userType) return safeReturn();
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MINUTES * 60000).toISOString();

    try {
      await db.insertOne('password_reset_tokens', {
        token: token,
        user_type: userType,
        user_identifier: userIdentifier,
        subaccount_slug: subaccountSlug,
        email: lowerEmail,
        expires_at: expiresAt
      });
    } catch (e) {
      console.error('forgot-password: token store failed:', e.message);
      return safeReturn();
    }

    const resetPath = (context === 'agency') ? '/agency' : '/' + slug;
    const resetLink = APP_URL + resetPath + '?reset=' + token;

    const html = '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#1a1030">'
      + '<h2 style="color:#6b21ea;margin:0 0 8px">Reset your password</h2>'
      + '<p style="margin:0 0 20px;color:#5a4d7a;font-size:15px">Hi' + (userName ? ' ' + userName : '') + ', we received a request to reset your MySpark+ password.</p>'
      + '<a href="' + resetLink + '" style="display:inline-block;background:#6b21ea;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:15px;margin-bottom:20px">Reset Password</a>'
      + '<p style="font-size:13px;color:#5a4d7a;margin:0 0 8px">This link expires in ' + TOKEN_EXPIRY_MINUTES + ' minutes. If you did not request this, ignore this email.</p>'
      + '<p style="font-size:12px;color:#9b8ec4;margin:0">MySpark+ by LitBiz Media</p>'
      + '</div>';

    try {
      const result = await sendEmail(null, {
        scope: 'agency',
        to: lowerEmail,
        subject: 'Reset your MySpark+ password',
        html: html,
        templateType: 'password_reset',
        subaccountId: subaccountSlug ? ('sub-' + subaccountSlug) : null
      });
      if (!result.ok) {
        console.error('forgot-password: mailgun send failed:', result.error);
      }
    } catch (e) {
      console.error('forgot-password: sendEmail threw:', e.message);
    }

    return safeReturn();

  } catch (e) {
    console.error('forgot-password: handler error:', e.message);
    return safeReturn();
  }
}

exports.handler = wrap(handler);
