// api/auth/forgot-password.js (Lambda version) - DEBUG VERSION
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
const { wrap } = require('./lib/lambda-adapter');
const crypto = require('crypto');

const APP_URL = process.env.APP_URL || 'https://mysparkplus.app';
const TOKEN_EXPIRY_MINUTES = 60;

// Load mailgun lazily so we can see init errors
let sendEmail = null;
let mailgunLoadError = null;
try {
  sendEmail = require('./lib/mailgun').sendEmail;
  console.log('[forgot-password] lib/mailgun loaded successfully');
} catch (e) {
  mailgunLoadError = e;
  console.error('[forgot-password] CRITICAL: lib/mailgun load failed:', e.message, e.stack);
}

async function handler(req, res) {
  console.log('[forgot-password] handler entered');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, context, slug } = req.body || {};
  console.log('[forgot-password] request:', { email, context, slug });

  if (!email || !context) {
    return res.status(400).json({ error: 'email and context required' });
  }
  if (['agency', 'subaccount'].indexOf(context) < 0) {
    return res.status(400).json({ error: 'context must be agency or subaccount' });
  }

  const lowerEmail = String(email).toLowerCase();

  const safeReturn = function() {
    return res.status(200).json({
      success: true,
      message: 'If that email is on file, a reset link is on its way.'
    });
  };

  // Check mailgun loaded
  if (mailgunLoadError) {
    console.error('[forgot-password] aborting - mailgun module failed to load:', mailgunLoadError.message);
    return safeReturn();
  }

  try {
    let userType = null;
    let userIdentifier = null;
    let subaccountSlug = slug || null;
    let userName = '';

    if (context === 'agency') {
      console.log('[forgot-password] agency lookup for', lowerEmail);
      const u = await db.findOne('agency_users',
        { email: lowerEmail, active: true },
        { select: 'id, name, email' }
      );
      console.log('[forgot-password] agency user found:', !!u);
      if (!u) return safeReturn();
      userType = 'agency';
      userIdentifier = u.id;
      userName = u.name || '';
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
      } catch (e) { console.warn('[forgot-password] subaccount_users lookup failed:', e.message); }

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
        } catch (e) { console.warn('[forgot-password] subaccounts lookup failed:', e.message); }
      }

      if (!userType) return safeReturn();
    }

    console.log('[forgot-password] user found, generating token. userType:', userType);

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
      console.log('[forgot-password] token stored');
    } catch (e) {
      console.error('[forgot-password] token store failed:', e.message);
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

    console.log('[forgot-password] about to call sendEmail');

    try {
      const result = await sendEmail(null, {
        scope: 'agency',
        to: lowerEmail,
        subject: 'Reset your MySpark+ password',
        html: html,
        templateType: 'password_reset',
        subaccountId: subaccountSlug ? ('sub-' + subaccountSlug) : null
      });
      console.log('[forgot-password] sendEmail returned:', JSON.stringify(result));
      if (!result.ok) {
        console.error('[forgot-password] mailgun send failed:', result.error);
      }
    } catch (e) {
      console.error('[forgot-password] sendEmail threw:', e.message, e.stack);
    }

    return safeReturn();

  } catch (e) {
    console.error('[forgot-password] OUTER CATCH:', e.message, e.stack);
    return safeReturn();
  }
}

exports.handler = wrap(handler);
