// api/auth/forgot-password.js
// Handles password reset requests for agency users and subaccount users (admin + staff).
// Generates a secure token, stores it, and sends a reset email via Resend.

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
  if (!['agency', 'subaccount'].includes(context)) {
    return res.status(400).json({ error: 'context must be agency or subaccount' });
  }

  // Always return success to prevent email enumeration
  const safeReturn = () => res.status(200).json({
    success: true,
    message: 'If that email is on file, a reset link is on its way.'
  });

  try {
    let userType = null;
    let userIdentifier = null;
    let subaccountSlug = slug || null;
    let userName = '';

    if (context === 'agency') {
      // Look up agency user by email
      const r = await fetch(
        SUPABASE_URL + '/rest/v1/agency_users?email=eq.' + encodeURIComponent(email.toLowerCase()) + '&active=eq.true&select=id,name,email',
        { headers: sbHeaders() }
      );
      if (!r.ok) return safeReturn();
      const rows = await r.json();
      if (!rows || !rows.length) return safeReturn();
      userType = 'agency';
      userIdentifier = rows[0].id;
      userName = rows[0].name || '';

    } else {
      // Subaccount context: check admin first, then staff
      if (!slug) return safeReturn();

      const subId = 'sub-' + slug;

      // Check subaccount admin email (stored in subaccounts.admin_email)
      const rSub = await fetch(
        SUPABASE_URL + '/rest/v1/subaccounts?id=eq.' + encodeURIComponent(subId) + '&admin_email=eq.' + encodeURIComponent(email.toLowerCase()) + '&select=id,name,admin_email',
        { headers: sbHeaders() }
      );
      if (rSub.ok) {
        const subRows = await rSub.json();
        if (subRows && subRows.length) {
          // Also fetch data blob to get the admin username
          let adminUsername = '';
          try {
            const rBlob = await fetch(
              SUPABASE_URL + '/rest/v1/subaccount_data?subaccount_id=eq.' + encodeURIComponent(subId) + '&select=data',
              { headers: sbHeaders() }
            );
            if (rBlob.ok) {
              const blobRows = await rBlob.json();
              if (blobRows && blobRows.length && blobRows[0].data) {
                const b = blobRows[0].data;
                if (b._subaccountAdmin && b._subaccountAdmin.username) {
                  adminUsername = b._subaccountAdmin.username;
                } else if (b.settings && b.settings.adminProfile && b.settings.adminProfile.username) {
                  adminUsername = b.settings.adminProfile.username;
                }
              }
            }
          } catch (e) {}
          userType = 'subaccount_admin';
          // Store subId:username so reset-password can create _subaccountAdmin if needed
          userIdentifier = adminUsername ? subId + ':' + adminUsername : subId;
          userName = subRows[0].name || '';
        }
      }

      // If not found as admin, check staff users in subaccount_data
      if (!userType) {
        const rData = await fetch(
          SUPABASE_URL + '/rest/v1/subaccount_data?subaccount_id=eq.' + encodeURIComponent(subId) + '&select=data',
          { headers: sbHeaders() }
        );
        if (rData.ok) {
          const dataRows = await rData.json();
          if (dataRows && dataRows.length && dataRows[0].data) {
            const blob = dataRows[0].data;
            // Check subaccount admin in blob
            if (blob._subaccountAdmin && blob._subaccountAdmin.email &&
                blob._subaccountAdmin.email.toLowerCase() === email.toLowerCase()) {
              userType = 'subaccount_admin';
              userIdentifier = blob._subaccountAdmin.username
                ? subId + ':' + blob._subaccountAdmin.username
                : subId;
              userName = blob._subaccountAdmin.name || '';
            }
            // Check staff users
            if (!userType && Array.isArray(blob.users)) {
              const staffUser = blob.users.find(function(u) {
                return u.email && u.email.toLowerCase() === email.toLowerCase() && u.active !== false;
              });
              if (staffUser) {
                userType = 'subaccount_staff';
                userIdentifier = subId + ':' + staffUser.username;
                userName = staffUser.name || staffUser.username || '';
              }
            }
          }
        }
      }

      if (!userType) return safeReturn();
    }

    // Generate secure token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MINUTES * 60000).toISOString();

    // Store token
    const rToken = await fetch(SUPABASE_URL + '/rest/v1/password_reset_tokens', {
      method: 'POST',
      headers: sbHeaders({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify({
        token,
        user_type: userType,
        user_identifier: userIdentifier,
        subaccount_slug: subaccountSlug,
        email: email.toLowerCase(),
        expires_at: expiresAt
      })
    });

    if (!rToken.ok) {
      console.error('forgot-password: token store failed', await rToken.text());
      return safeReturn();
    }

    // Build reset link
    const resetPath = context === 'agency' ? '/agency' : '/' + slug;
    const resetLink = APP_URL + resetPath + '?reset=' + token;

    // Send email via Resend
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
        to: [email.toLowerCase()],
        subject: 'Reset your MySpark+ password',
        html
      })
    });

    return safeReturn();

  } catch (e) {
    console.error('forgot-password error:', e);
    return safeReturn(); // Always safe return
  }
};
