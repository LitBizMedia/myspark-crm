// api/auth/reset-password.js
// Validates a reset token and updates the user's password.
// Works for agency users, subaccount admins, and subaccount staff.

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sbHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

// SHA-256 hash matching the frontend's sha256() function
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Node 18+ has crypto.subtle. For older Node, fall back to crypto.createHash.
function hashPassword(password) {
  try {
    return crypto.createHash('sha256').update(password).digest('hex');
  } catch (e) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) {
    return res.status(400).json({ error: 'token and newPassword required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    // Look up token
    const rToken = await fetch(
      SUPABASE_URL + '/rest/v1/password_reset_tokens?token=eq.' + encodeURIComponent(token) + '&select=*',
      { headers: sbHeaders() }
    );
    if (!rToken.ok) return res.status(500).json({ error: 'Token lookup failed' });
    const tokens = await rToken.json();
    if (!tokens || !tokens.length) {
      return res.status(400).json({ error: 'Invalid or expired reset link.' });
    }

    const rec = tokens[0];

    if (rec.used_at) {
      return res.status(400).json({ error: 'This reset link has already been used.' });
    }
    if (new Date(rec.expires_at) < new Date()) {
      return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });
    }

    // Hash the new password
    const passwordHash = hashPassword(newPassword);
    if (!passwordHash) {
      return res.status(500).json({ error: 'Password hashing failed' });
    }

    // Update password based on user_type
    if (rec.user_type === 'agency') {
      const r = await fetch(
        SUPABASE_URL + '/rest/v1/agency_users?id=eq.' + encodeURIComponent(rec.user_identifier),
        {
          method: 'PATCH',
          headers: sbHeaders(),
          body: JSON.stringify({ password_hash: passwordHash, updated_at: new Date().toISOString() })
        }
      );
      if (!r.ok) return res.status(500).json({ error: 'Failed to update password' });

    } else if (rec.user_type === 'subaccount_admin') {
      // Update _subaccountAdmin.passwordHash in subaccount_data blob
      const subId = rec.user_identifier;
      const rData = await fetch(
        SUPABASE_URL + '/rest/v1/subaccount_data?subaccount_id=eq.' + encodeURIComponent(subId) + '&select=id,data',
        { headers: sbHeaders() }
      );
      if (!rData.ok) return res.status(500).json({ error: 'Failed to load subaccount data' });
      const rows = await rData.json();
      if (!rows || !rows.length) return res.status(404).json({ error: 'Subaccount data not found' });
      const blob = rows[0].data;
      if (!blob._subaccountAdmin) return res.status(404).json({ error: 'Subaccount admin not found' });
      blob._subaccountAdmin.passwordHash = passwordHash;
      const rUpdate = await fetch(
        SUPABASE_URL + '/rest/v1/subaccount_data?id=eq.' + encodeURIComponent(rows[0].id),
        {
          method: 'PATCH',
          headers: sbHeaders(),
          body: JSON.stringify({ data: blob, updated_at: new Date().toISOString() })
        }
      );
      if (!rUpdate.ok) return res.status(500).json({ error: 'Failed to update password' });

    } else if (rec.user_type === 'subaccount_staff') {
      // user_identifier format: subaccountId:username
      const [subId, username] = rec.user_identifier.split(':');
      if (!subId || !username) return res.status(400).json({ error: 'Invalid user identifier' });
      const rData = await fetch(
        SUPABASE_URL + '/rest/v1/subaccount_data?subaccount_id=eq.' + encodeURIComponent(subId) + '&select=id,data',
        { headers: sbHeaders() }
      );
      if (!rData.ok) return res.status(500).json({ error: 'Failed to load subaccount data' });
      const rows = await rData.json();
      if (!rows || !rows.length) return res.status(404).json({ error: 'Subaccount data not found' });
      const blob = rows[0].data;
      const userIdx = (blob.users || []).findIndex(function(u) { return u.username === username; });
      if (userIdx === -1) return res.status(404).json({ error: 'Staff user not found' });
      blob.users[userIdx].passwordHash = passwordHash;
      const rUpdate = await fetch(
        SUPABASE_URL + '/rest/v1/subaccount_data?id=eq.' + encodeURIComponent(rows[0].id),
        {
          method: 'PATCH',
          headers: sbHeaders(),
          body: JSON.stringify({ data: blob, updated_at: new Date().toISOString() })
        }
      );
      if (!rUpdate.ok) return res.status(500).json({ error: 'Failed to update password' });

    } else {
      return res.status(400).json({ error: 'Unknown user type' });
    }

    // Mark token as used
    await fetch(
      SUPABASE_URL + '/rest/v1/password_reset_tokens?token=eq.' + encodeURIComponent(token),
      {
        method: 'PATCH',
        headers: sbHeaders(),
        body: JSON.stringify({ used_at: new Date().toISOString() })
      }
    );

    return res.status(200).json({ success: true, message: 'Password updated. You can now log in.' });

  } catch (e) {
    console.error('reset-password error:', e);
    return res.status(500).json({ error: 'Reset failed: ' + e.message });
  }
};
