CREATE OR REPLACE VIEW trending_wallpapers_view AS
SELECT 
  wallpaper_url, 
  MAX(low_res_url) as low_res_url, 
  MAX(category) as category, 
  count(*) as favourite_count
FROM favourites
GROUP BY wallpaper_url
ORDER BY count(*) DESC;
