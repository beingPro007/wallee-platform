-- Add to collections table
ALTER TABLE collections ADD COLUMN is_public BOOLEAN DEFAULT false;
ALTER TABLE collections ADD COLUMN published_at TIMESTAMPTZ;
ALTER TABLE collections ADD COLUMN likes_count INT DEFAULT 0;

-- New table for likes
CREATE TABLE collection_likes (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  collection_id INT REFERENCES collections(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, collection_id)
);

-- RPCs for atomic like increments
CREATE OR REPLACE FUNCTION increment_collection_likes(col_id INT)
RETURNS void AS $$
  UPDATE collections SET likes_count = likes_count + 1 WHERE id = col_id;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION decrement_collection_likes(col_id INT)
RETURNS void AS $$
  UPDATE collections SET likes_count = GREATEST(0, likes_count - 1) WHERE id = col_id;
$$ LANGUAGE sql;