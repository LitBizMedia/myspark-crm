const db = require('./lib/db');
exports.handler = async (event) => {
  // Final safety check before dropping
  const before = await db.query(`SELECT COUNT(*) AS cnt FROM email_log`);
  const cmCount = await db.query(`SELECT COUNT(*) AS cnt FROM conversation_messages`);
  const ageCount = await db.query(`SELECT COUNT(*) AS cnt FROM agency_email_log`);

  if (event.confirm !== 'DROP_EMAIL_LOG') {
    return {
      action: 'PREVIEW_ONLY',
      email_log_rows: before.rows[0].cnt,
      conversation_messages_rows: cmCount.rows[0].cnt,
      agency_email_log_rows: ageCount.rows[0].cnt,
      message: 'Re-invoke with payload {"confirm": "DROP_EMAIL_LOG"} to drop'
    };
  }

  await db.query(`DROP TABLE email_log`);

  // Verify drop
  const stillExists = await db.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'email_log' AND table_schema = 'public'
  `);

  return {
    action: 'DROPPED',
    email_log_rows_before: before.rows[0].cnt,
    table_still_exists: stillExists.rows.length > 0,
    final_state: {
      conversation_messages: cmCount.rows[0].cnt,
      agency_email_log: ageCount.rows[0].cnt
    }
  };
};
