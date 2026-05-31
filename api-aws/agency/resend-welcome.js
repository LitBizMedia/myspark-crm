// api/agency/resend-welcome.js
// POST /api/agency/resend-welcome
// Regenerates a setup token and resends the welcome/setup email to a subaccount admin.

const db = require('./lib/db');
const crypto = require('crypto');
const { requireAgencyAdmin } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');
const agencyEmails = require('./lib/agency-emails');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAdmin(req, res);
  if (!auth) return;

  const { subaccountId } = req.body || {};
  if (!subaccountId) return res.status(400).json({ error: 'subaccountId required' });

  try {
    const sub = await db.findOne('subaccounts',
      { id: subaccountId },
      { select: 'id, slug, name, admin_email, admin_username' }
    );
    if (!sub) return res.status(404).json({ error: 'Subaccount not found' });
    if (!sub.admin_email) return res.status(400).json({ error: 'No admin email on file for this subaccount' });

    // Find the admin user
    let adminUser;
    try {
      adminUser = await db.findOne('subaccount_users',
        { subaccount_id: subaccountId, username: sub.admin_username },
        { select: 'id, email, display_name' }
      );
    } catch (e) {
      console.warn('resend-welcome: admin user lookup failed:', e.message);
    }
    if (!adminUser) return res.status(404).json({ error: 'Admin user record not found' });

    // Get plan info for the email
    let planRow = null;
    try {
      planRow = await db.findOne('subaccount_plans',
        { subaccount_id: subaccountId },
        { select: 'plan_tier, billing_period, trial_days' }
      );
    } catch (e) { /* ignore */ }

    // Generate fresh setup token (7-day expiry)
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await db.insertOne('password_reset_tokens', {
      token: token,
      user_type: 'subaccount_user',
      user_identifier: adminUser.id,
      subaccount_slug: sub.slug,
      email: sub.admin_email,
      expires_at: expiresAt
    });
    const setupUrl = 'https://mysparkplus.app/' + sub.slug + '?reset=' + token;

    // Send welcome email
    await agencyEmails.sendEmail(sub.admin_email, 'welcome_subaccount', {
      subName: sub.name,
      adminName: adminUser.display_name || sub.admin_username,
      slug: sub.slug,
      planTier: planRow ? planRow.plan_tier : '',
      billingPeriod: planRow ? planRow.billing_period : 'monthly',
      trialDays: planRow ? planRow.trial_days : 0,
      setupUrl: setupUrl,
      subaccountId: subaccountId
    });

    await logAudit({
      req,
      actorType: 'agency_admin',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'agency.subaccount.welcome_resent',
      targetType: 'subaccount',
      targetId: subaccountId,
      targetSubaccountId: subaccountId,
      metadata: { admin_email: sub.admin_email }
    });

    return res.status(200).json({ success: true, sent_to: sub.admin_email });
  } catch (e) {
    console.error('resend-welcome error:', e);
    return res.status(500).json({ error: 'Failed to resend welcome: ' + e.message });
  }
}

exports.handler = wrap(handler);
