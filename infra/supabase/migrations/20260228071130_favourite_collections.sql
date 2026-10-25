-- ============================================================================
-- ENSURE EVERY USER HAS A "FAVOURITES" COLLECTION
-- AND SYNC IT WITH THE LEGACY FAVOURITES TABLE
-- ============================================================================

-- 1. Ensure unique constraints
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collections_user_id_name_key') THEN
        ALTER TABLE public.collections ADD CONSTRAINT collections_user_id_name_key UNIQUE (user_id, name);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collection_wallpapers_unique_item') THEN
        DELETE FROM public.collection_wallpapers a USING public.collection_wallpapers b 
        WHERE a.id < b.id AND a.collection_id = b.collection_id AND a.wallpaper_url = b.wallpaper_url;
        
        ALTER TABLE public.collection_wallpapers ADD CONSTRAINT collection_wallpapers_unique_item UNIQUE (collection_id, wallpaper_url);
    END IF;
END $$;

-- 2. Helper to get or create Favourites collection
CREATE OR REPLACE FUNCTION public.get_or_create_favourites_collection(target_user_id UUID)
RETURNS INT AS $$
DECLARE
    fav_id INT;
BEGIN
    INSERT INTO public.collections (user_id, name, is_public, created_at)
    VALUES (target_user_id, 'Favourites', false, now())
    ON CONFLICT (user_id, name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO fav_id;
    
    RETURN fav_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Trigger: Favourites Table -> Collection (SYNC A)
CREATE OR REPLACE FUNCTION public.sync_favourites_to_collection()
RETURNS TRIGGER AS $$
DECLARE
    fav_collection_id INT;
BEGIN
    IF (TG_OP = 'INSERT') THEN
        fav_collection_id := public.get_or_create_favourites_collection(NEW.user_id);
        INSERT INTO public.collection_wallpapers (collection_id, wallpaper_url, created_at)
        VALUES (fav_collection_id, NEW.wallpaper_url, NEW.created_at)
        ON CONFLICT (collection_id, wallpaper_url) DO NOTHING;
    ELSIF (TG_OP = 'DELETE') THEN
        SELECT id INTO fav_collection_id FROM public.collections 
        WHERE user_id = OLD.user_id AND name = 'Favourites' LIMIT 1;
        IF fav_collection_id IS NOT NULL THEN
            DELETE FROM public.collection_wallpapers
            WHERE collection_id = fav_collection_id AND wallpaper_url = OLD.wallpaper_url;
        END IF;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_favourite_change ON public.favourites;
CREATE TRIGGER on_favourite_change
AFTER INSERT OR DELETE ON public.favourites
FOR EACH ROW EXECUTE PROCEDURE public.sync_favourites_to_collection();

-- 4. Trigger: Collection -> Favourites Table (SYNC B - Two Way)
CREATE OR REPLACE FUNCTION public.sync_collection_to_favourites()
RETURNS TRIGGER AS $$
DECLARE
    is_fav_collection BOOLEAN;
    owner_id UUID;
BEGIN
    -- Check if this is the 'Favourites' collection
    SELECT (name = 'Favourites'), user_id INTO is_fav_collection, owner_id 
    FROM public.collections WHERE id = (CASE WHEN TG_OP = 'DELETE' THEN OLD.collection_id ELSE NEW.collection_id END);

    IF is_fav_collection THEN
        IF (TG_OP = 'INSERT') THEN
            INSERT INTO public.favourites (user_id, wallpaper_url, created_at)
            VALUES (owner_id, NEW.wallpaper_url, NEW.created_at)
            ON CONFLICT (user_id, wallpaper_url) DO NOTHING;
        ELSIF (TG_OP = 'DELETE') THEN
            DELETE FROM public.favourites
            WHERE user_id = owner_id AND wallpaper_url = OLD.wallpaper_url;
        END IF;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_collection_wallpaper_change ON public.collection_wallpapers;
CREATE TRIGGER on_collection_wallpaper_change
AFTER INSERT OR DELETE ON public.collection_wallpapers
FOR EACH ROW EXECUTE PROCEDURE public.sync_collection_to_favourites();

-- 5. Backfills (Existing user logic remains same)
INSERT INTO public.collections (user_id, name, is_public, created_at)
SELECT id, 'Favourites', false, now()
FROM auth.users
ON CONFLICT (user_id, name) DO NOTHING;

INSERT INTO public.collection_wallpapers (collection_id, wallpaper_url, created_at)
SELECT c.id, f.wallpaper_url, f.created_at
FROM public.favourites f
JOIN public.collections c ON c.user_id = f.user_id AND c.name = 'Favourites'
ON CONFLICT (collection_id, wallpaper_url) DO NOTHING;
