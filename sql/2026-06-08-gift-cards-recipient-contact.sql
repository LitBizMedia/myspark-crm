-- Recipient-as-contact link for gift cards (match-on-email at issue, no creation).
-- recipient_contact_id is DISTINCT from contact_id (the buyer). Nullable; the
-- card only links a recipient when their email matches an existing contact.
ALTER TABLE gift_cards
  ADD COLUMN IF NOT EXISTS recipient_contact_id TEXT
    REFERENCES contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_gift_cards_recipient_contact
  ON gift_cards (subaccount_id, recipient_contact_id)
  WHERE recipient_contact_id IS NOT NULL;
