// POST /api/subaccount/class-sessions-enroll
// Enrolls or cancels a contact from a class session.
// Body: { session_id, contact_id, action: 'enroll' | 'cancel' }
//
// Idempotent enroll: if the contact is already enrolled, returns 200 with
// { already_enrolled: true } and makes no DB change. The frontend uses this
// to show an "already on the roster" message instead of a generic success.
const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const { session_id, contact_id, action } = req.body || {};
  if (!session_id || !contact_id || !action) {
    return res.status(400).json({ error: 'session_id, contact_id, action required' });
  }
  if (!['enroll','cancel'].includes(action)) {
    return res.status(400).json({ error: 'action must be enroll or cancel' });
  }

  const subaccountId = auth.subaccount_id;

  try {
    const r = await db.query(
      'SELECT id, participants, capacity FROM class_sessions WHERE id=$1 AND subaccount_id=$2',
      [session_id, subaccountId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Session not found' });

    const session = r.rows[0];
    let participants = Array.isArray(session.participants) ? session.participants : [];

    if (action === 'enroll') {
      // Idempotent guard: already enrolled means no-op success.
      const existing = participants.find(p => p.contact_id === contact_id);
      const wasAlreadyEnrolled = existing && existing.status === 'enrolled';

      if (wasAlreadyEnrolled) {
        const enrolled_count = participants.filter(p => p.status === 'enrolled').length;
        // Audit the no-op for traceability.
        await logAudit({
          req, actorType:'subaccount', actorId:auth.user_id,
          actorUsername:auth.username, actorRole:auth.role,
          action: 'subaccount.class_session.enroll',
          targetType:'class_session', targetId:session_id,
          targetSubaccountId:subaccountId,
          metadata:{ contact_id, action, no_op: true, reason: 'already_enrolled' }
        });
        return res.status(200).json({
          success: true,
          already_enrolled: true,
          participants,
          enrolled_count
        });
      }

      // Capacity check only applies when we actually intend to add.
      const enrolled = participants.filter(p => p.status === 'enrolled').length;
      if (enrolled >= session.capacity) {
        return res.status(409).json({ error: 'Class is full' });
      }

      if (existing) {
        // Was previously cancelled, re-enrolling.
        existing.status = 'enrolled';
        existing.enrolled_at = new Date().toISOString();
      } else {
        participants.push({
          contact_id,
          status: 'enrolled',
          enrolled_at: new Date().toISOString()
        });
      }
    } else {
      // cancel
      const p = participants.find(p => p.contact_id === contact_id);
      if (p) p.status = 'cancelled';
    }

    await db.query(
      'UPDATE class_sessions SET participants=$1, updated_at=NOW() WHERE id=$2',
      [JSON.stringify(participants), session_id]
    );

    await logAudit({
      req, actorType:'subaccount', actorId:auth.user_id,
      actorUsername:auth.username, actorRole:auth.role,
      action: `subaccount.class_session.${action}`,
      targetType:'class_session', targetId:session_id,
      targetSubaccountId:subaccountId,
      metadata:{ contact_id, action }
    });

    const enrolled_count = participants.filter(p => p.status === 'enrolled').length;
    return res.status(200).json({ success:true, participants, enrolled_count });
  } catch(e) {
    console.error('class-sessions-enroll error:', e.message);
    return res.status(500).json({ error:'Failed to update enrollment' });
  }
}
exports.handler = wrap(handler);
