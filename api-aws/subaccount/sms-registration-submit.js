// api/subaccount/sms-registration-submit.js (Lambda version)
// POST /api/subaccount/sms-registration-submit
//
// Accepts full A2P registration data from the 4-step form. Supports two modes:
//   1. status='draft' - save partial progress, validation skipped
//   2. status='requested' (default) - final submission, all required fields validated
//
// Upserts a single row per subaccount (one active registration at a time).

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const agencyEmails = require('./lib/agency-emails');
const { wrap } = require('./lib/lambda-adapter');

// Twilio-supported business types
const BUSINESS_TYPES = ['Sole Proprietorship', 'Partnership', 'LLC', 'Corporation', 'Co-operative', 'Non-profit'];

// Twilio-supported use cases
const USE_CASES = ['Customer Care', 'Account Notification', 'Marketing', 'Mixed', 'Polling/Voting', 'Public Service Announcement', 'Higher Education', 'Charity (501c3)', 'Political', 'Security', 'Two-Factor Authentication'];

// Twilio-supported opt-in methods
const OPT_IN_METHODS = ['Verbal', 'Web Form', 'Paper Form', 'Via Text', 'Mobile QR Code'];

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res, { requireRole: 'admin' });
  if (!auth) return;

  const r = req.body || {};
  const isDraft = r.is_draft === true;
  const targetStatus = isDraft ? 'draft' : 'requested';

  // Validate required fields only on final submission
  if (!isDraft) {
    const required = [
      'legal_business_name', 'ein', 'business_type', 'business_industry',
      'address_street', 'address_city', 'address_state', 'address_zip',
      'contact_first_name', 'contact_last_name', 'contact_title',
      'contact_email', 'contact_phone',
      'use_case', 'use_case_description',
      'sample_message_1', 'sample_message_2',
      'opt_in_method', 'opt_in_description'
    ];
    for (const f of required) {
      if (!r[f] || String(r[f]).trim() === '') {
        return res.status(400).json({ error: f + ' is required', field: f });
      }
    }
    // Validate enum-style fields
    if (!BUSINESS_TYPES.includes(r.business_type)) {
      return res.status(400).json({ error: 'Invalid business_type', field: 'business_type' });
    }
    if (!USE_CASES.includes(r.use_case)) {
      return res.status(400).json({ error: 'Invalid use_case', field: 'use_case' });
    }
    if (!OPT_IN_METHODS.includes(r.opt_in_method)) {
      return res.status(400).json({ error: 'Invalid opt_in_method', field: 'opt_in_method' });
    }
  }

  const subaccountId = auth.subaccount_id;
  const slug = subaccountId.replace(/^sub-/, '');
  const subaccountName = r.subaccount_name || slug;

  // Build a combined contact_name for backward compat with old agency UI
  const contactName = [r.contact_first_name, r.contact_last_name].filter(Boolean).join(' ') || r.contact_name || null;

  // Render sample messages: replace {business_name} placeholder with actual
  // business name so Twilio sees realistic samples on submission only.
  let s1 = r.sample_message_1 || null;
  let s2 = r.sample_message_2 || null;
  let s3 = r.sample_message_3 || null;
  if (!isDraft) {
    const bname = r.legal_business_name || subaccountName;
    if (s1) s1 = s1.replace(/\{business_name\}/g, bname);
    if (s2) s2 = s2.replace(/\{business_name\}/g, bname);
    if (s3) s3 = s3.replace(/\{business_name\}/g, bname);
  }

  try {
    // Upsert: one row per subaccount, latest data wins
    const existing = await db.query(
      `SELECT id, status FROM sms_registration_requests WHERE subaccount_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [subaccountId]
    );

    let row;
    if (existing.rowCount > 0 && (existing.rows[0].status === 'draft' || isDraft)) {
      // Update existing draft or current row when saving a new draft
      const upd = await db.query(`
        UPDATE sms_registration_requests SET
          subaccount_name = $2,
          legal_business_name = $3,
          ein = $4,
          business_type = $5,
          business_industry = $6,
          business_country = $7,
          website = $8,
          address_street = $9,
          address_city = $10,
          address_state = $11,
          address_zip = $12,
          contact_first_name = $13,
          contact_last_name = $14,
          contact_name = $15,
          contact_title = $16,
          contact_email = $17,
          contact_phone = $18,
          use_case = $19,
          use_case_description = $20,
          sample_message_1 = $21,
          sample_message_2 = $22,
          sample_message_3 = $23,
          opt_in_method = $24,
          opt_in_description = $25,
          status = $26,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [
        existing.rows[0].id, subaccountName,
        r.legal_business_name || null, r.ein || null, r.business_type || null,
        r.business_industry || null, r.business_country || 'US', r.website || null,
        r.address_street || null, r.address_city || null, r.address_state || null, r.address_zip || null,
        r.contact_first_name || null, r.contact_last_name || null, contactName, r.contact_title || null,
        r.contact_email || null, r.contact_phone || null,
        r.use_case || null, r.use_case_description || null,
        s1, s2, s3,
        r.opt_in_method || null, r.opt_in_description || null,
        targetStatus
      ]);
      row = upd.rows[0];
    } else {
      // Insert new row
      const ins = await db.query(`
        INSERT INTO sms_registration_requests (
          subaccount_id, subaccount_name,
          legal_business_name, ein, business_type, business_industry, business_country, website,
          address_street, address_city, address_state, address_zip,
          contact_first_name, contact_last_name, contact_name, contact_title, contact_email, contact_phone,
          use_case, use_case_description,
          sample_message_1, sample_message_2, sample_message_3,
          opt_in_method, opt_in_description,
          status, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, NOW(), NOW())
        RETURNING *
      `, [
        subaccountId, subaccountName,
        r.legal_business_name || null, r.ein || null, r.business_type || null,
        r.business_industry || null, r.business_country || 'US', r.website || null,
        r.address_street || null, r.address_city || null, r.address_state || null, r.address_zip || null,
        r.contact_first_name || null, r.contact_last_name || null, contactName, r.contact_title || null,
        r.contact_email || null, r.contact_phone || null,
        r.use_case || null, r.use_case_description || null,
        s1, s2, s3,
        r.opt_in_method || null, r.opt_in_description || null,
        targetStatus
      ]);
      row = ins.rows[0];
    }

    // Send acknowledgement email when actually submitted (not on save-draft)
    if (!isDraft && r.contact_email) {
      try {
        // Get subaccount name for context
        let subName = subaccountId;
        try {
          const sub = await db.findOne('subaccounts', { id: subaccountId }, { select: 'name' });
          if (sub) subName = sub.name;
        } catch (e) { /* ignore */ }
        await agencyEmails.sendEmail(r.contact_email, 'sms_request_received', {
          subName: subName,
          contactName: (r.contact_first_name && r.contact_last_name)
            ? (r.contact_first_name + ' ' + r.contact_last_name)
            : (r.contact_name || 'there'),
          businessName: r.legal_business_name,
          subaccountId: subaccountId
        });
      } catch (emailErr) {
        console.error('sms-registration-submit: ack email failed:', emailErr.message);
      }
    }

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: isDraft ? 'subaccount.sms_registration.draft' : 'subaccount.sms_registration.submit',
      targetType: 'sms_registration',
      targetId: row.id,
      targetSubaccountId: subaccountId,
      metadata: {
        legal_business_name: r.legal_business_name,
        status: targetStatus
      }
    });

    return res.status(200).json({ request: row });
  } catch (e) {
    console.error('sms-registration-submit error:', e.message);
    return res.status(500).json({ error: 'Failed to submit registration: ' + e.message });
  }
}

exports.handler = wrap(handler);
