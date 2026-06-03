-- Forms a booking of this service should auto-trigger as intake.
-- Empty array = no intake forms. One or more form ids = send each on a
-- qualifying first booking. The dispatcher's per-(contact,form) guard handles
-- dedup, so listing two forms (e.g. standard + prenatal-geared service) sends
-- two independent links. Manual sends from the contact drawer cover anything
-- the system cannot infer (e.g. pregnancy), bypassing the auto path entirely.
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS intake_form_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
