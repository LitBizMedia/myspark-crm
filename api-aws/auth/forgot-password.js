// api/auth/forgot-password.js (Lambda version)
//
// POST /api/auth/forgot-password
//
// Generates a secure token, stores it, sends a reset email via Resend.
// Always returns success to prevent email enumeration attacks.
//
// MIGRATED: Supabase REST → lib/db.js for user lookups and token storage.

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const crypto = require('crypto');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const APP_URL = process.env.APP_URL || 'https://mysparkplus.app';
const FROM_EMAIL = 'noreply@mysparkplus.app';
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
      // Agency user lookup
      const u = await db.findOne('agency_users',
        { email: lowerEmail, active: true },
        { select: 'id, name, email' }
      );
      if (!u) return safeReturn();
      userType = 'agency';
      userIdentifier = u.id;
      userName = u.name || '';

    } else {
      // Subaccount user lookup
      if (!slug) return safeReturn();
      const subId = 'sub-' + slug;

      // 1. Try subaccount_users table first
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
      } catch (e) { /* fall through */ }

      // 2. Legacy fallback: subaccounts.admin_email
      if (!userType) {
        try {
          const sub = await db.findOne('subaccounts',
            { id: subId, admin_email: lowerEmail },
            { select: 'id, name, admin_username, admin_email' }
          );
          if (sub && sub.admin_username) {
            userType = 'subaccount_user';
            userIdentifier = subId + ':' + sub.admin_username;
            userName = sub.name || sub.admin_username || '';
          }
        } catch (e) { /* swallow */ }
      }

      if (!userType) return safeReturn();
    }

    // Generate token, store, email
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
      console.error('forgot-password: token store failed', e.message);
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
}

exports.handler = wrap(handler);
