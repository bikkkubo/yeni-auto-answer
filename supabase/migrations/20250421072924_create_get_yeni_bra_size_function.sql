-- Function to determine cup letter based on top-under difference
-- Note: This uses a simplified mapping. Adjust ranges/letters as needed.
CREATE OR REPLACE FUNCTION public.get_cup_from_diff (diff integer)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN diff >= 8 AND diff < 11.5 THEN 'A' -- Approx 8-11 cm
    WHEN diff >= 11.5 AND diff < 14 THEN 'B' -- Approx 11.5-13.5 cm
    WHEN diff >= 14 AND diff < 16.5 THEN 'C' -- Approx 14-16 cm
    WHEN diff >= 16.5 AND diff < 19 THEN 'D' -- Approx 16.5-18.5 cm
    WHEN diff >= 19 AND diff < 21.5 THEN 'E' -- Approx 19-21 cm
    WHEN diff >= 21.5 AND diff < 24 THEN 'F' -- Approx 21.5-23.5 cm
    WHEN diff >= 24 AND diff < 26.5 THEN 'G' -- Approx 24-26 cm
    WHEN diff >= 26.5 AND diff < 29 THEN 'H' -- Approx 26.5-28.5 cm
    WHEN diff >= 29 AND diff < 31.5 THEN 'I' -- Approx 29-31 cm
    WHEN diff >= 31.5 THEN 'J'           -- Approx 31.5+ cm
    ELSE NULL
  END;
$$;

-- RPC function to get Yeni bra size based on measurements or cup letter
CREATE OR REPLACE FUNCTION public.get_yeni_bra_size (
  p_under_bust integer default null,
  p_top_bust integer default null,
  p_cup_letter text default null
)
RETURNS TABLE (
  yeni_size text,
  note text
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_cup_letter text;
BEGIN
  -- Priority 1: Calculate cup from difference if both measurements are provided
  IF p_under_bust IS NOT NULL AND p_top_bust IS NOT NULL AND p_top_bust > p_under_bust THEN
    v_cup_letter := public.get_cup_from_diff(p_top_bust - p_under_bust);
  -- Priority 2: Use provided cup letter if calculation is not possible
  ELSIF p_cup_letter IS NOT NULL THEN
    v_cup_letter := upper(trim(p_cup_letter)); -- Normalize input
  ELSE
    -- Not enough information
    v_cup_letter := NULL;
  END IF;

  -- Search the sizes table if we have under_bust and a determined cup_letter
  IF p_under_bust IS NOT NULL AND v_cup_letter IS NOT NULL THEN
    RETURN QUERY
    SELECT
      s.yeni_size,
      s.note
    FROM public.sizes s
    WHERE
      s.category = 'bra' -- Ensure we only get bra sizes
      AND p_under_bust >= s.under_min
      AND p_under_bust < s.under_max + 1 -- Assuming ranges are like 65-69, 70-74 etc.
      -- Simple string comparison for cups (works if single letters A-J)
      AND v_cup_letter >= s.cup_min
      AND v_cup_letter <= s.cup_max
    LIMIT 1; -- Return the first match found
  END IF;

  -- If no match or not enough info, return empty set
  RETURN;

END;
$$;
