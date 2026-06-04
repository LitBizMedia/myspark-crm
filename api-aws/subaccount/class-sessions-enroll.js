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
const { fireIntakeForClassRegistration } = require('./lib/intake-trigger');
const { getContactById } = require('./lib/contacts');

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

      // Collapse any duplicate rows for this contact to a single enrolled row.
      // Dirty data from before dedup existed could have multiple rows per
      // contact. Keep the earliest enrolled_at so history of first signup holds.
      const sameContact = participants.filter(p => p.contact_id === contact_id);
      if (sameContact.length > 0) {
        const earliest = sameContact
          .map(p => p.enrolled_at)
          .filter(Boolean)
          .sort()[0] || new Date().toISOString();
        participants = participants.filter(p => p.contact_id !== contact_id);
        participants.push({
          contact_id,
          status: 'enrolled',
          enrolled_at: earliest
        });
      } else {
        participants.push({
          contact_id,
          status: 'enrolled',
          enrolled_at: new Date().toISOString()
        });
      }
    } else {
      // cancel: collapse all rows for this contact to a single cancelled row.
      // Using filter+set (not find) heals dirty data with duplicate rows, which
      // is what silently broke Remove when a cancelled and enrolled row coexisted.
      const sameContact = participants.filter(p => p.contact_id === contact_id);
      if (sameContact.length > 0) {
        const earliest = sameContact
          .map(p => p.enrolled_at)
          .filter(Boolean)
          .sort()[0] || new Date().toISOString();
        participants = participants.filter(p => p.contact_id !== contact_id);
        participants.push({
          contact_id,
          status: 'cancelled',
          enrolled_at: earliest
        });
      }
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

    // Class intake: fire only on a genuine enroll (not cancel). The form's
    // sendFrequency policy decides whether to actually send, so a re-enroll of
    // someone who already got a 'once' form won't resend. Staff enroll is a
    // first-class trigger source: scheduled for a class => get the form,
    // regardless of who scheduled. Awaited + wrapped; never fails the enroll.
    if (action === 'enroll') {
      try {
        const slug = String(subaccountId).replace(/^sub-/, '');
        const c = await getContactById(subaccountId, contact_id);
        await fireIntakeForClassRegistration({
          subaccountId,
          slug,
          contactId: contact_id,
          classSessionId: session_id,
          contact: {
            email: (c && c.email) || '',
            phone: (c && c.phone) || '',
            name: (c && (c.display_name || c.name)) || ''
          }
        });
      } catch (e) {
        console.error('fireIntakeForClassRegistration (enroll) failed (non-fatal):', e.message);
      }
    }

    const enrolled_count = participants.filter(p => p.status === 'enrolled').length;
    return res.status(200).json({ success:true, participants, enrolled_count });
  } catch(e) {
    console.error('class-sessions-enroll error:', e.message);
    return res.status(500).json({ error:'Failed to update enrollment' });
  }
}
exports.handler = wrap(handler);
