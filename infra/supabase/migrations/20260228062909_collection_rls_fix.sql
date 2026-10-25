-- ============================================================================
-- COMPLETE RLS policies for collections & collection_wallpapers
-- Previous migration only had SELECT + UPDATE. INSERT & DELETE were missing,
-- which silently blocked all writes.
-- ============================================================================

-- Ensure RLS is enabled (idempotent)
ALTER TABLE collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_wallpapers ENABLE ROW LEVEL SECURITY;

-- ── collections ─────────────────────────────────────────────────────────────

-- SELECT: owner sees own + public
DROP POLICY IF EXISTS "Public collections are viewable by everyone" ON collections;
CREATE POLICY "Public collections are viewable by everyone" ON collections
FOR SELECT USING (is_public = true OR auth.uid() = user_id);

-- INSERT: authenticated users can create their own
DROP POLICY IF EXISTS "Users can insert their own collections" ON collections;
CREATE POLICY "Users can insert their own collections" ON collections
FOR INSERT WITH CHECK (auth.uid() = user_id);

-- UPDATE: owners only
DROP POLICY IF EXISTS "Users can update their own collections" ON collections;
CREATE POLICY "Users can update their own collections" ON collections
FOR UPDATE USING (auth.uid() = user_id);

-- DELETE: owners only
DROP POLICY IF EXISTS "Users can delete their own collections" ON collections;
CREATE POLICY "Users can delete their own collections" ON collections
FOR DELETE USING (auth.uid() = user_id);

-- ── collection_wallpapers ───────────────────────────────────────────────────

-- SELECT: everyone can read (needed for public collection previews)
DROP POLICY IF EXISTS "Anyone can see collection items" ON collection_wallpapers;
CREATE POLICY "Anyone can see collection items" ON collection_wallpapers
FOR SELECT USING (true);

-- INSERT: user can add wallpapers to their OWN collections
DROP POLICY IF EXISTS "Users can add wallpapers to own collections" ON collection_wallpapers;
CREATE POLICY "Users can add wallpapers to own collections" ON collection_wallpapers
FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM collections
    WHERE collections.id = collection_id
    AND collections.user_id = auth.uid()
  )
);

-- DELETE: user can remove wallpapers from their OWN collections
DROP POLICY IF EXISTS "Users can remove wallpapers from own collections" ON collection_wallpapers;
CREATE POLICY "Users can remove wallpapers from own collections" ON collection_wallpapers
FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM collections
    WHERE collections.id = collection_id
    AND collections.user_id = auth.uid()
  )
);
