-- Personalization tables for trait sheet + per-trait/provider blocks

CREATE TABLE IF NOT EXISTS public.user_traits (
  user_id uuid PRIMARY KEY,
  version integer NOT NULL DEFAULT 1,
  sheet jsonb NOT NULL DEFAULT '{}'::jsonb,
  derived_at timestamptz,
  source_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_traits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own traits all" ON public.user_traits
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.user_trait_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  category text NOT NULL,
  trait_path text NOT NULL,
  blocked_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, category, trait_path)
);

ALTER TABLE public.user_trait_blocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own trait blocks all" ON public.user_trait_blocks
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_user_trait_blocks_user ON public.user_trait_blocks(user_id);

CREATE TABLE IF NOT EXISTS public.user_provider_category_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  provider_tier smallint NOT NULL CHECK (provider_tier BETWEEN 0 AND 3),
  category text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider_tier, category)
);

ALTER TABLE public.user_provider_category_blocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own provider category blocks all" ON public.user_provider_category_blocks
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_user_provider_cat_blocks_user ON public.user_provider_category_blocks(user_id);

CREATE TRIGGER user_traits_set_updated_at
  BEFORE UPDATE ON public.user_traits
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();