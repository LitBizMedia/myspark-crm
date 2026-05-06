// api/subaccount/soap-notes-list.js (Lambda)
// GET /api/subaccount/soap-notes-list?contact_id=...
// Returns all SOAP notes for a given contact, most recent first.
// Audited as a PHI list view.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

// A note is considered locked if it has been signed OR more than 24h has
// elapsed since creation. Computed at read time so the lock state is always
// fresh without needing a background job.
function isLocked(row) {
  if (row.signed_at) return true;
  const created = new Date(row.created_at).getTime();
  return Date.now() - created > 24 * 60 * 60 * 1000;
}

function rowToNote(row) {
  return {
    id: row.id,
    contactId: row.contact_id,
    appointmentId: row.appointment_id,
    authorId: row.author_id,
    subjective: row.subjective || '',
    objective:  row.objective  || '',
    assessment: row.assessment || '',
    plan:       row.plan       || '',
    visitDate: row.visit_date || null,
    templateUsed: row.template_used || null,
    signedAt: row.signed_at,
    locked: isLocked(row),
    amendments: row.amendments || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const contactId = (req.query && req.query.contact_id) || null;
  if (!contactId) return res.status(400).json({ error: 'contact_id is required' });

  const subaccountId = auth.subaccount_id;

  try {
    const result = await db.query(
      `SELECT * FROM soap_notes
       WHERE subaccount_id = $1 AND contact_id = $2
       ORDER BY COALESCE(visit_date, created_at::date) DESC, created_at DESC`,
      [subaccountId, contactId]
    );

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.soap_note.list',
      targetType: 'contact',
      targetId: contactId,
      targetSubaccountId: subaccountId,
      metadata: { count: result.rows.length }
    });

    return res.status(200).json({
      success: true,
      notes: result.rows.map(rowToNote)
    });
  } catch (e) {
    console.error('soap-notes-list error:', e.message);
    return res.status(500).json({ error: 'Failed to load SOAP notes' });
  }
}

exports.handler = wrap(handler);
