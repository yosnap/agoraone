-- A counter that changes whenever the searchable vectors or the confidentiality of their notes change.
-- Fragment ids can be reused after a note is edited, so ids alone cannot tell the in-memory matrix that
-- it is stale.

CREATE TABLE vector_generation (
  only INTEGER PRIMARY KEY CHECK (only = 1),
  n INTEGER NOT NULL
);
INSERT INTO vector_generation (only, n) VALUES (1, 0);

CREATE TRIGGER vector_generation_embedded AFTER UPDATE OF embedding, embed_model ON chunk BEGIN
  UPDATE vector_generation SET n = n + 1 WHERE only = 1;
END;
CREATE TRIGGER vector_generation_deleted AFTER DELETE ON chunk BEGIN
  UPDATE vector_generation SET n = n + 1 WHERE only = 1;
END;
CREATE TRIGGER vector_generation_level AFTER UPDATE OF confidentiality ON item BEGIN
  UPDATE vector_generation SET n = n + 1 WHERE only = 1;
END;

-- Finding fragments still without a vector uses the partial index.
CREATE INDEX chunk_model ON chunk (embed_model);
