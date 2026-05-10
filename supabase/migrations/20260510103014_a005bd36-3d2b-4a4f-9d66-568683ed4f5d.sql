CREATE TABLE public.search_queries (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  query text NOT NULL,
  engine text NOT NULL DEFAULT 'perplexity',
  result_count integer NOT NULL DEFAULT 0,
  opened_url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.search_queries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own search queries select"
  ON public.search_queries FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "own search queries insert"
  ON public.search_queries FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "own search queries delete"
  ON public.search_queries FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX idx_search_queries_user_created
  ON public.search_queries (user_id, created_at DESC);