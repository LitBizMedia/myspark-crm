-- 2026-06-04: Widen conversation_messages.source CHECK constraint.
--
-- Problem: the original constraint allowed only an exact list
--   (manual, reminder, confirmation, cancellation, widget, system).
-- Five of six email sender libs pass source values outside that list:
--   appointment-emails.js        -> 'reschedule'
--   appointment-cancellation     -> 'cancellation-<who>'  (dynamic suffix)
--   payment-receipt-email.js     -> 'payment-receipt-<src>' (dynamic suffix)
--   refund-email.js              -> 'refund'
--   contract-signed-email.js     -> 'contract-signed'
-- logSubaccountMessage() swallows the insert error in a try/catch, so the
-- emails still sent but NONE of these message types ever logged to the
-- conversation thread. Silent data loss in the inbox since the constraint
-- was added.
--
-- Fix: pattern-tolerant CHECK. Base set + the two dynamic prefixes +
-- the three concrete strays. Tolerates future <prefix>-* suffixes so this
-- class of drift cannot silently recur, while still rejecting true garbage.

ALTER TABLE conversation_messages
  DROP CONSTRAINT IF EXISTS conversation_messages_source_check;

ALTER TABLE conversation_messages
  ADD CONSTRAINT conversation_messages_source_check CHECK (
    source IN ('manual','reminder','confirmation','cancellation','widget','system',
               'reschedule','refund','contract-signed','intake-form')
    OR source LIKE 'cancellation-%'
    OR source LIKE 'payment-receipt-%'
  );

-- 2026-06-04 (later): added 'intake-form' to the allowed set. The intake-form
-- email sender (lib-aws/intake-dispatch.js) logs to the patient thread with
-- source='intake-form'; it was hitting this constraint and silently failing to
-- log (same swallowed-error pattern). This file reflects the final live state.
