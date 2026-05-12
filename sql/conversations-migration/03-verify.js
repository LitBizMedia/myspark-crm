const db = require('./lib/db');
exports.handler = async (event) => {
  const conversations = await db.query(`
    SELECT c.id, c.subaccount_id, c.contact_id, c.channel, c.status,
           c.last_message_at, c.last_message_preview, c.reply_token,
           COUNT(cm.id) AS message_count
    FROM conversations c
    LEFT JOIN conversation_messages cm ON cm.conversation_id = c.id
    GROUP BY c.id
    ORDER BY c.last_message_at DESC
  `);

  const messageBySource = await db.query(`
    SELECT source, COUNT(*) AS cnt
    FROM conversation_messages
    GROUP BY source
    ORDER BY cnt DESC
  `);

  const orphanMessages = await db.query(`
    SELECT COUNT(*) AS cnt
    FROM conversation_messages cm
    LEFT JOIN conversations c ON c.id = cm.conversation_id
    WHERE c.id IS NULL
  `);

  const agencyByTemplate = await db.query(`
    SELECT template_type, COUNT(*) AS cnt
    FROM agency_email_log
    GROUP BY template_type
  `);

  // Reconciliation: every email_log row in bucket B must have a corresponding conversation_messages row
  const reconcileB = await db.query(`
    SELECT COUNT(*) AS missing
    FROM email_log el
    WHERE el.template_type IN ('appt-reminder','appt-cancellation','appt-confirmation','booking-confirmation')
      AND el.contact_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM conversation_messages cm
        WHERE cm.external_id = el.resend_email_id
      )
  `);

  const reconcileA = await db.query(`
    SELECT COUNT(*) AS missing
    FROM email_log el
    WHERE (el.template_type = 'welcome' OR el.subject LIKE 'Your MySpark+ workspace is ready%')
      AND NOT EXISTS (
        SELECT 1 FROM agency_email_log ael
        WHERE ael.resend_email_id = el.resend_email_id
      )
  `);

  return {
    conversations: conversations.rows,
    messages_by_source: messageBySource.rows,
    orphan_messages: orphanMessages.rows[0],
    agency_by_template: agencyByTemplate.rows,
    bucket_b_missing: reconcileB.rows[0],
    bucket_a_missing: reconcileA.rows[0]
  };
};
