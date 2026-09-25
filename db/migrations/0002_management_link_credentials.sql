ALTER TABLE management_spaces ADD COLUMN management_token_hash TEXT;

CREATE UNIQUE INDEX management_spaces_management_token_hash_idx
  ON management_spaces (management_token_hash)
  WHERE management_token_hash IS NOT NULL;
