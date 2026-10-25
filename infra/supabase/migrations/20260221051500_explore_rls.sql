-- Ensure RLS is active
ALTER TABLE collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_wallpapers ENABLE ROW LEVEL SECURITY;

-- 1. Anyone can view public collections
DROP POLICY IF EXISTS "Public collections are viewable by everyone" ON collections;
CREATE POLICY "Public collections are viewable by everyone" ON collections
FOR SELECT USING (is_public = true OR auth.uid() = user_id);

-- 2. Owners can update their own collections (for publishing)
DROP POLICY IF EXISTS "Users can update their own collections" ON collections;
CREATE POLICY "Users can update their own collections" ON collections
FOR UPDATE USING (auth.uid() = user_id);

-- 3. Anyone can view wallpaper counts/items in the community
DROP POLICY IF EXISTS "Anyone can see collection items" ON collection_wallpapers;
CREATE POLICY "Anyone can see collection items" ON collection_wallpapers
FOR SELECT USING (true);