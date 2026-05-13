// api/email/ses-events.js (Lambda)
//
// Triggered by SNS topic 'myspark-ses-events' which receives publish events
// from the SES configuration set 'myspark-events'. One SNS message per
// email event (SEND, DELIVERY, BOUNCE, COMPLAINT, DELIVERY_DELAY,
// RENDERING_FAILURE, REJECT).
//
// Updates the corresponding row in conversation_messages first, falls back
// to agency_email_log. Suppresses recipient for hard bounces and complaints.

const db = require('./lib/db');

// Map SES event type → our internal status
const STATUS_MAP = {
  Send: 'sent',
  Delivery: 'delivered',
  Bounce: 'bounced',
  Complaint: 'complained',
  DeliveryDelay: 'delayed',
  Reject: 'rejected',
  RenderingFailure: 'rendering_failed'
};

async function updateMessageStatus(messageId, status, errorMessage) {
  if (!messageId) return { updated: 0, table: null };

  // Try conversation_messages first
  try {
    const cm = await db.update('conversation_messages',
      { status, error: errorMessage || null },
      { external_id: messageId }
    );
    const cmRows = (cm && (cm.rowCount || cm.affectedRows || (Array.isArray(cm) ? cm.length : 0))) || 0;
    if (cmRows > 0) return { updated: cmRows, table: 'conversation_messages' };
  } catch (e) {
    console.error('conversation_messages update error:', e.message);
  }

  // Fallback to agency_email_log
  try {
    const updates = { status };
    if (errorMessage) updates.error_message = errorMessage;
    const agl = await db.update('agency_email_log', updates, { resend_email_id: messageId });
    const aglRows = (agl && (agl.rowCount || agl.affectedRows || (Array.isArray(agl) ? agl.length : 0))) || 0;
    return { updated: aglRows, table: aglRows > 0 ? 'agency_email_log' : null };
  } catch (e) {
    console.error('agency_email_log update error:', e.message);
    return { updated: 0, table: null };
  }
}

async function suppressContact(email, reason, notes) {
  if (!email) return;
  try {
    // Mark contacts with this email as having a bad address.
    // Idempotent: matches across all subaccounts since email could be on multiple contact rows.
    await db.query(
      `UPDATE contacts 
       SET email_suppressed = TRUE, 
           email_suppression_reason = $1, 
           email_suppression_notes = $2,
           email_suppressed_at = NOW()
       WHERE LOWER(email) = LOWER($3)`,
      [reason, notes || null, email]
    );
  } catch (e) {
    // If columns don't exist yet, log but don't fail. We'll add migration separately.
    console.error('suppressContact error (non-fatal):', e.message);
  }
}

async function processEvent(sesEvent) {
  const eventType = sesEvent.eventType || sesEvent.notificationType;
  if (!eventType) {
    console.warn('SES event missing eventType:', JSON.stringify(sesEvent).slice(0, 200));
    return;
  }

  const mail = sesEvent.mail || {};
  const messageId = mail.messageId;
  if (!messageId) {
    console.warn('SES event missing mail.messageId:', JSON.stringify(sesEvent).slice(0, 200));
    return;
  }

  const status = STATUS_MAP[eventType];
  if (!status) {
    console.log('Unhandled SES event type:', eventType);
    return;
  }

  // Compose error message for failure events
  let errorMessage = null;
  if (eventType === 'Bounce') {
    const bounce = sesEvent.bounce || {};
    const recipients = (bounce.bouncedRecipients || []).map(r => r.emailAddress).join(', ');
    errorMessage = `${bounce.bounceType || 'Bounce'}: ${bounce.bounceSubType || ''} (${recipients})`;
  } else if (eventType === 'Complaint') {
    const c = sesEvent.complaint || {};
    const recipients = (c.complainedRecipients || []).map(r => r.emailAddress).join(', ');
    errorMessage = `Complaint: ${c.complaintFeedbackType || 'spam'} (${recipients})`;
  } else if (eventType === 'Reject') {
    errorMessage = (sesEvent.reject && sesEvent.reject.reason) || 'Rejected by SES';
  } else if (eventType === 'RenderingFailure') {
    errorMessage = (sesEvent.failure && sesEvent.failure.errorMessage) || 'Rendering failure';
  } else if (eventType === 'DeliveryDelay') {
    const d = sesEvent.deliveryDelay || {};
    errorMessage = `Delay: ${d.delayType || 'unknown'}`;
  }

  // Update status in the appropriate table
  const result = await updateMessageStatus(messageId, status, errorMessage);
  console.log(`SES ${eventType} for ${messageId}: updated ${result.updated} row(s) in ${result.table || 'no table'}`);

  // Suppress contact for hard bounces and complaints
  if (eventType === 'Bounce') {
    const bounce = sesEvent.bounce || {};
    if (bounce.bounceType === 'Permanent') {
      const recipients = bounce.bouncedRecipients || [];
      for (const r of recipients) {
        if (r.emailAddress) {
          await suppressContact(r.emailAddress, 'bounce_permanent', bounce.bounceSubType || null);
          console.log('Suppressed (permanent bounce):', r.emailAddress);
        }
      }
    }
  } else if (eventType === 'Complaint') {
    const c = sesEvent.complaint || {};
    const recipients = c.complainedRecipients || [];
    for (const r of recipients) {
      if (r.emailAddress) {
        await suppressContact(r.emailAddress, 'complaint', c.complaintFeedbackType || null);
        console.log('Suppressed (complaint):', r.emailAddress);
      }
    }
  }
}

exports.handler = async (event, context) => {
  const records = event.Records || [];
  for (const record of records) {
    if (record.EventSource !== 'aws:sns' && record.eventSource !== 'aws:sns') {
      console.warn('Unexpected record source:', record.EventSource || record.eventSource);
      continue;
    }
    const sns = record.Sns || {};
    if (!sns.Message) {
      console.warn('SNS record missing Message');
      continue;
    }
    let sesEvent;
    try {
      sesEvent = JSON.parse(sns.Message);
    } catch (e) {
      console.error('Failed to parse SNS message as JSON:', e.message);
      continue;
    }
    try {
      await processEvent(sesEvent);
    } catch (e) {
      console.error('Error processing event:', e.message, e.stack);
      // Don't rethrow - we don't want one bad event to block the batch
    }
  }
  return { ok: true, processed: records.length };
};
