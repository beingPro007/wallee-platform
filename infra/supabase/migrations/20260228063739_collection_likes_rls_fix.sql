
-- ── collection_likes ────────────────────────────────────────────────────────

ALTER TABLE collection_likes ENABLE ROW LEVEL SECURITY;

-- SELECT: users can see their own likes (needed to show liked state)
DROP POLICY IF EXISTS "Users can see their own likes" ON collection_likes;
CREATE POLICY "Users can see their own likes" ON collection_likes
FOR SELECT USING (auth.uid() = user_id);

-- INSERT: users can like any collection
DROP POLICY IF EXISTS "Users can like collections" ON collection_likes;
CREATE POLICY "Users can like collections" ON collection_likes
FOR INSERT WITH CHECK (auth.uid() = user_id);

-- DELETE: users can unlike (remove their own likes)
DROP POLICY IF EXISTS "Users can unlike collections" ON collection_likes;
CREATE POLICY "Users can unlike collections" ON collection_likes
FOR DELETE USING (auth.uid() = user_id);

-- ── Likes RPC functions (SECURITY DEFINER) ──────────────────────────────────
-- These need SECURITY DEFINER because they UPDATE collections.likes_count
-- on OTHER users' collections, which the owner-only UPDATE policy would block.

CREATE OR REPLACE FUNCTION increment_collection_likes(col_id INT)
RETURNS void AS $$
  UPDATE collections SET likes_count = likes_count + 1 WHERE id = col_id;
$$ LANGUAGE sql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION decrement_collection_likes(col_id INT)
RETURNS void AS $$
  UPDATE collections SET likes_count = GREATEST(0, likes_count - 1) WHERE id = col_id;
$$ LANGUAGE sql SECURITY DEFINER;
