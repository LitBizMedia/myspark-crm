// api/subaccount/appointments-delete.js (Lambda version)
// POST /api/subaccount/appointments-delete
//
// SOFT-CANCEL pattern. Instead of removing the row, sets status='cancelled'.
// Preserves audit trail, payment record linkage, reporting integrity, and
// HIPAA-aligned record retention. The frontend treats cancelled appointments
// as visually distinct (strikethrough) but they remain queryable.
//
// Returns the full updated appointment row so the frontend can update its
// local state without a re-fetch.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');
const { sendCancellationEmail } = require('./lib/appointment-cancellation-email');
const contactsLib = require('./lib/contacts');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required' });

  const subaccountId = auth.subaccount_id;

  try {
    // Capture appointment data BEFORE the cancel for the audit log
    // and any downstream notification.
    const before = await db.query(
      `SELECT id, title, date, time, status, contact_id, assigned_to, service_id, price
         FROM appointments
        WHERE id = $1 AND subaccount_id = $2`,
      [id, subaccountId]
    );
    if (before.rowCount === 0) {
      return res.status(404).json({ error: 'Appointment not found' });
    }
    const appt = before.rows[0];

    // Already cancelled? Idempotent: return the row as-is.
    if (appt.status === 'cancelled') {
      return res.status(200).json({
        success: true,
        id,
        appointment: appt,
        already_cancelled: true
      });
    }

    // Soft-cancel: status -> 'cancelled', updated_at -> NOW.
    await db.query(
      `UPDATE appointments
          SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1 AND subaccount_id = $2`,
      [id, subaccountId]
    );

    // Re-fetch the updated row for the response.
    const after = await db.query(
      `SELECT * FROM appointments WHERE id = $1 AND subaccount_id = $2`,
      [id, subaccountId]
    );

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.appointment.cancel',
      targetType: 'appointment',
      targetId: id,
      targetSubaccountId: subaccountId,
      metadata: {
        previous_status: appt.status,
        title: appt.title,
        date: appt.date,
        contact_id: appt.contact_id
      }
    });

    // Fire cancellation email (non-fatal). Skip if the appointment was already
    // in the past (likely backdated cleanup) OR if its prior status was not an
    // active state. Cancelling a completed, no-show, or rescheduled appointment
    // is cleanup, not a real cancellation the patient needs to hear about.
    try {
      const apptDate = appt.date ? String(appt.date).slice(0, 10) : null;
      const todayStr = new Date().toISOString().slice(0, 10);
      const isPast = apptDate && apptDate < todayStr;

      const SUPPRESS_EMAIL_STATUSES = ['completed', 'no_show', 'noshow', 'rescheduled'];
      const statusSuppressed = SUPPRESS_EMAIL_STATUSES.includes(String(appt.status || '').toLowerCase());

      if (!isPast && !statusSuppressed && appt.contact_id) {
        const contact = await contactsLib.getContactById(subaccountId, appt.contact_id);
        if (contact && contact.email) {
          // Look up business name + slug
          let businessName = 'MySpark+';
          try {
            const sdRow = await db.findOne('subaccount_data', { subaccount_id: subaccountId });
            const settings = (sdRow && sdRow.data && sdRow.data.settings) || {};
            businessName = settings.businessName || settings.business_name || businessName;
          } catch (e) { /* default */ }

          const slug = subaccountId.replace(/^sub-/, '');
          await sendCancellationEmail({
            subaccountId,
            subaccountSlug: slug,
            recipientEmail: contact.email,
            recipientName: contact.name || contact.first_name || '',
            contactId: contact.id,
            businessName,
            appointmentTitle: appt.title || 'Appointment',
            appointmentDate: appt.date,
            appointmentTime: appt.time,
            staffName: '',
            source: 'staff'
          });
        }
      }
    } catch (sendErr) {
      console.warn('cancellation email send failed (non-fatal):', sendErr.message);
    }

    return res.status(200).json({
      success: true,
      id,
      appointment: after.rows[0],
      previous_status: appt.status
    });
  } catch (e) {
    console.error('appointments-delete (soft-cancel) error:', e.message);
    return res.status(500).json({ error: 'Failed to cancel appointment' });
  }
}

exports.handler = wrap(handler);
