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
//   id, name, slug, tier, adminUsername, adminPassword
// Optional:
//   adminEmail, adminName (display name; defaults to adminUsername)
//   adminColor (defaults to #6b21ea)
//   billingPeriod, hipaaAddon, status, exemptFromBilling, discountPercent, discountNote
//   initData (overrides for the data blob; user-related fields stripped before save)

const db = require('./lib/db');
const { requireAgencyAdmin } = require('./lib/require-subaccount-auth');
const { hashPassword } = require('./lib/subaccount-auth');
const { logAudit } = require('./lib/audit');
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
  if (!b.adminUsername) return res.status(400).json({ error: 'adminUsername required' });
  if (!b.adminPassword) return res.status(400).json({ error: 'adminPassword required' });

  const subId = b.id;
  const slug = b.slug;
  const adminUsername = String(b.adminUsername).trim().toLowerCase();
  const adminEmail = b.adminEmail ? String(b.adminEmail).trim().toLowerCase() : null;
  const adminName = b.adminName || adminUsername;
  const adminColor = b.adminColor || '#6b21ea';

  const initData = sanitizeBlob(b.initData || {});

  let adminPasswordHash;
  try {
    adminPasswordHash = await hashPassword(String(b.adminPassword));
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
          exempt_from_billing, discount_percent, discount_note, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
        ON CONFLICT (subaccount_id) DO UPDATE SET
          plan_tier = EXCLUDED.plan_tier,
          billing_period = EXCLUDED.billing_period,
          hipaa_addon = EXCLUDED.hipaa_addon,
          status = EXCLUDED.status,
          exempt_from_billing = EXCLUDED.exempt_from_billing,
          discount_percent = EXCLUDED.discount_percent,
          discount_note = EXCLUDED.discount_note,
          updated_at = NOW()
      `, [
        subId, b.tier, b.billingPeriod || 'monthly', !!b.hipaaAddon,
        b.status || 'exempt',
        b.exemptFromBilling !== false,
        parseInt(b.discountPercent) || 0,
        b.discountNote || null
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
