-- Links written in each note ([[target]]), for the brain's graph. The target is kept normalised (last
-- path step, without .md, heading, block or alias; NFC and case-folded) and resolved by title when the
-- graph is built, so a link to a note that does not exist yet costs nothing.

CREATE TABLE note_link (
  item_id INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  target TEXT NOT NULL CHECK (length(target) BETWEEN 1 AND 300),
  PRIMARY KEY (item_id, target)
) WITHOUT ROWID;
CREATE INDEX note_link_target ON note_link (target);

-- Notes indexed before this migration have no links yet: forgetting their revision makes the backend
-- send them again on its next pass.
UPDATE item SET revision = NULL WHERE class = 'note';
