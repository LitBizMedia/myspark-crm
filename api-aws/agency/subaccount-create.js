// api/agency/subaccount-create.js (Lambda version)
// POST /api/agency/subaccount-create
//
// Creates: subaccounts row + subaccount_data blob + subaccount_plans row +
// subaccount_users row for the admin (with bcrypt-hashed password).
//
// All four inserts run in a single transaction via db.transaction().
// If any one fails, all roll back.
//
// Required body fields:
//   id, name, slug, tier, adminEmail (adminUsername no longer required - email used as login)
// Optional:
//   adminEmail, adminName (display name; defaults to adminUsername)
//   adminColor (defaults to #6b21ea)
//   billingPeriod, hipaaAddon, status, exemptFromBilling, discountPercent, discountNote
//   initData (overrides for the data blob; user-related fields stripped before save)

const db = require('./lib/db');
const { requireAgencyAdmin } = require('./lib/require-subaccount-auth');
const { hashPassword } = require('./lib/subaccount-auth');
const { logAudit } = require('./lib/audit');
const agencyEmails = require('./lib/agency-emails');
const { wrap } = require('./lib/lambda-adapter');

// Mirror data-save Lambda's strip list. The blob never holds user data.
const STRIPPED_TOP_LEVEL = ['users', '_subaccountAdmin'];
const STRIPPED_SETTINGS = ['adminProfile'];

function sanitizeBlob(data) {
  const out = { ...data };
  for (const k of STRIPPED_TOP_LEVEL) {
    if (k in out) delete out[k];
  }
  if (out.settings && typeof out.settings === 'object') {
    out.settings = { ...out.settings };
    for (const k of STRIPPED_SETTINGS) {
      if (k in out.settings) delete out.settings[k];
    }
  }
  return out;
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAdmin(req, res);
  if (!auth) return;

  const b = req.body || {};
  if (!b.id) return res.status(400).json({ error: 'id required' });
  if (!b.name) return res.status(400).json({ error: 'name required' });
  if (!b.slug) return res.status(400).json({ error: 'slug required' });
  if (!b.tier) return res.status(400).json({ error: 'tier required' });
  if (!b.adminEmail) return res.status(400).json({ error: 'adminEmail required (used as login)' });
  // adminPassword is now optional. If absent, generate a throwaway and send setup link.
  // If admin provided one, we still honor it AND send setup link so they can use either.
  const useTempPassword = !b.adminPassword;
  const effectivePassword = b.adminPassword || ('temp_' + require('crypto').randomBytes(16).toString('hex') + 'A1!');

  const subId = b.id;
  const slug = b.slug;
  // Username IS the email. We keep the username column for backward compat
  // but new accounts get email as the value.
  const adminEmailNormalized = String(b.adminEmail).trim().toLowerCase();
  const adminUsername = adminEmailNormalized;
  const adminEmail = b.adminEmail ? String(b.adminEmail).trim().toLowerCase() : null;
  const adminName = b.adminName || adminUsername;
  const adminColor = b.adminColor || '#6b21ea';

  const initData = sanitizeBlob(b.initData || {});

  let adminPasswordHash;
  try {
    adminPasswordHash = await hashPassword(String(effectivePassword));
  } catch (e) {
    console.error('subaccount-create: password hash failed:', e.message);
    return res.status(500).json({ error: 'Password hashing failed' });
  }

  const adminUserId = require('crypto').randomUUID();

  try {
    await db.transaction(async (client) => {
      // 1. Insert subaccount
      await client.query(`
        INSERT INTO subaccounts (id, agency_id, name, slug, plan, active, admin_email, admin_username, created_at)
        VALUES ($1, 'agency-main', $2, $3, $4, true, $5, $6, NOW())
      `, [subId, b.name, slug, b.tier, adminEmail, adminUsername]);

      // 2. Insert initial subaccount_data blob (sanitized)
      await client.query(`
        INSERT INTO subaccount_data (id, subaccount_id, data, updated_at)
        VALUES ($1, $2, $3::jsonb, NOW())
      `, ['data-' + slug, subId, JSON.stringify(initData)]);

      // 3. Insert subaccount_plans row
      await client.query(`
        INSERT INTO subaccount_plans (
          subaccount_id, plan_tier, billing_period, hipaa_addon, status,
          exempt_from_billing, discount_percent, discount_note, linked_contact_id,
          created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
        ON CONFLICT (subaccount_id) DO UPDATE SET
          plan_tier = EXCLUDED.plan_tier,
          billing_period = EXCLUDED.billing_period,
          hipaa_addon = EXCLUDED.hipaa_addon,
          status = EXCLUDED.status,
          exempt_from_billing = EXCLUDED.exempt_from_billing,
          discount_percent = EXCLUDED.discount_percent,
          discount_note = EXCLUDED.discount_note,
          linked_contact_id = EXCLUDED.linked_contact_id,
          updated_at = NOW()
      `, [
        subId, b.tier, b.billingPeriod || 'monthly', !!b.hipaaAddon,
        b.status || 'exempt',
        b.exemptFromBilling !== false,
        parseInt(b.discountPercent) || 0,
        b.discountNote || null,
        b.linkedContactId || null
      ]);

      // 4. Insert subaccount_users row for the admin.
      //    must_change_password = true so the admin must rotate on first login.
      await client.query(`
        INSERT INTO subaccount_users (
          id, subaccount_id, username, display_name, email,
          password_hash, role, color, active, must_change_password,
          created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'admin', $7, true, true, NOW(), NOW())
      `, [
        adminUserId, subId, adminUsername, adminName, adminEmail,
        adminPasswordHash, adminColor
      ]);
    });

    // Generate setup token for magic link flow
    let setupUrl = null;
    try {
      if (adminEmail) {
        const crypto = require('crypto');
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
        await db.insertOne('password_reset_tokens', {
          token: token,
          user_type: 'subaccount_user',
          user_identifier: adminUserId,
          subaccount_slug: slug,
          email: adminEmail,
          expires_at: expiresAt
        });
        setupUrl = 'https://mysparkplus.app/' + slug + '?reset=' + token;
      }
    } catch (e) {
      console.error('subaccount-create: setup token generation failed:', e.message);
    }

    // Send welcome email to new admin (best-effort)
    try {
      if (adminEmail) {
        // Get plan details for the email
        let planRow = null;
        try {
          planRow = await db.findOne('subaccount_plans', { subaccount_id: subId }, { select: 'plan_tier, billing_period, trial_days' });
        } catch (e) { /* ignore */ }
        const loginUrl = 'https://mysparkplus.app/' + slug;
      await agencyEmails.sendEmail(adminEmail, 'welcome_subaccount', {
        loginUrl: loginUrl,
        adminEmail: adminEmail,
          subName: b.name,
          adminName: adminName || adminUsername,
          slug: slug,
          planTier: planRow ? planRow.plan_tier : (b.tier || ''),
          billingPeriod: planRow ? planRow.billing_period : (b.billingPeriod || 'monthly'),
          trialDays: planRow ? planRow.trial_days : 0,
          setupUrl: setupUrl,
          loginUrl: 'https://mysparkplus.app/' + slug,
          subaccountId: subId
        });
      }
    } catch (emailErr) {
      console.error('subaccount-create: welcome email failed:', emailErr.message);
    }

    await logAudit({
      req,
      actorType: 'agency_admin',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'agency.subaccount.create',
      targetType: 'subaccount',
      targetId: subId,
      targetSubaccountId: subId,
      metadata: {
        name: b.name, slug, tier: b.tier,
        admin_user_id: adminUserId,
        admin_username: adminUsername
      }
    });

    return res.status(200).json({
      success: true,
      id: subId,
      admin_user_id: adminUserId
    });
  } catch (e) {
    console.error('subaccount-create error:', e.message);
    return res.status(500).json({ error: 'Failed to create subaccount: ' + e.message });
  }
}

exports.handler = wrap(handler);
