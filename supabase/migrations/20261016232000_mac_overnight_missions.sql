-- Restore missing research runtime prerequisites, using plain owner UUIDs.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agent_state_enum') THEN CREATE TYPE public.agent_state_enum AS ENUM ('draft','active','paused','degraded','inactive','error','needs_user_attention','archived'); END IF; IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agent_run_status_enum') THEN CREATE TYPE public.agent_run_status_enum AS ENUM ('running','ok','failed','partial_success','skipped_budget_exceeded','skipped_disabled','timeout','cancelled'); END IF; IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agent_finding_state_enum') THEN CREATE TYPE public.agent_finding_state_enum AS ENUM ('new','seen','accepted','dismissed','snoozed','archived'); END IF; END $$;
CREATE TABLE IF NOT EXISTS public.agents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, template_id text NOT NULL, display_name text NOT NULL, config jsonb NOT NULL DEFAULT '{}'::jsonb, badge text NOT NULL, state public.agent_state_enum NOT NULL DEFAULT 'draft', cadence_hours int NOT NULL DEFAULT 24, budget jsonb NOT NULL, notify jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), last_claimed_at timestamptz, last_completed_at timestamptz, last_useful_at timestamptz, claim_expires_at timestamptz, consecutive_failures int NOT NULL DEFAULT 0, CONSTRAINT agents_cadence_positive CHECK(cadence_hours>0), CONSTRAINT agents_cadence_reasonable CHECK(cadence_hours<=8760), CONSTRAINT agents_consecutive_failures_nonneg CHECK(consecutive_failures>=0)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.agents TO authenticated;
GRANT ALL ON public.agents TO service_role;
ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agents_owner_all ON public.agents;
CREATE POLICY agents_owner_all ON public.agents FOR ALL TO authenticated USING(user_id=auth.uid()) WITH CHECK(user_id=auth.uid());
CREATE INDEX IF NOT EXISTS agents_user_state_idx ON public.agents(user_id,state);
CREATE INDEX IF NOT EXISTS agents_due_idx ON public.agents(state,last_completed_at) WHERE state IN ('active','degraded','inactive');
DROP TRIGGER IF EXISTS agents_set_updated ON public.agents;
CREATE TRIGGER agents_set_updated BEFORE UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TABLE IF NOT EXISTS public.agent_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE, user_id uuid NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, status public.agent_run_status_enum NOT NULL DEFAULT 'running', items_fetched int NOT NULL DEFAULT 0, items_kept int NOT NULL DEFAULT 0, llm_hops int NOT NULL DEFAULT 0, cost_usd numeric(10,6) NOT NULL DEFAULT 0, error text, briefing jsonb
);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.agent_runs TO authenticated;
GRANT ALL ON public.agent_runs TO service_role;
ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_runs_owner_all ON public.agent_runs;
CREATE POLICY agent_runs_owner_all ON public.agent_runs FOR ALL TO authenticated USING(user_id=auth.uid()) WITH CHECK(user_id=auth.uid());
ALTER TABLE public.agent_runs ADD COLUMN IF NOT EXISTS briefing jsonb;
CREATE INDEX IF NOT EXISTS agent_runs_agent_started_idx ON public.agent_runs(agent_id,started_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_user_started_idx ON public.agent_runs(user_id,started_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_running_started_idx ON public.agent_runs(started_at) WHERE status='running';
CREATE TABLE IF NOT EXISTS public.agent_findings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE, user_id uuid NOT NULL, run_id uuid NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE, dedupe_key text NOT NULL, title text NOT NULL, summary text, source_url text, payload jsonb NOT NULL DEFAULT '{}'::jsonb, score numeric(4,3) NOT NULL, state public.agent_finding_state_enum NOT NULL DEFAULT 'new', urgency text NOT NULL DEFAULT 'normal', user_feedback text, created_at timestamptz NOT NULL DEFAULT now(), acted_at timestamptz, CONSTRAINT agent_findings_dedupe_unique UNIQUE(agent_id,dedupe_key), CONSTRAINT agent_findings_urgency_check CHECK(urgency IN ('normal','urgent')), CONSTRAINT agent_findings_score_check CHECK(score>=0 AND score<=1)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.agent_findings TO authenticated;
GRANT ALL ON public.agent_findings TO service_role;
ALTER TABLE public.agent_findings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_findings_owner_all ON public.agent_findings;
CREATE POLICY agent_findings_owner_all ON public.agent_findings FOR ALL TO authenticated USING(user_id=auth.uid()) WITH CHECK(user_id=auth.uid());
CREATE INDEX IF NOT EXISTS agent_findings_user_state_idx ON public.agent_findings(user_id,state,created_at DESC);
CREATE INDEX IF NOT EXISTS agent_findings_agent_created_idx ON public.agent_findings(agent_id,created_at DESC);
CREATE TABLE IF NOT EXISTS public.agent_state (
 agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE, user_id uuid NOT NULL, key text NOT NULL, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(agent_id,key)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.agent_state TO authenticated;
GRANT ALL ON public.agent_state TO service_role;
ALTER TABLE public.agent_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_state_owner_all ON public.agent_state;
CREATE POLICY agent_state_owner_all ON public.agent_state FOR ALL TO authenticated USING(user_id=auth.uid()) WITH CHECK(user_id=auth.uid());
CREATE INDEX IF NOT EXISTS agent_state_user_idx ON public.agent_state(user_id);
CREATE OR REPLACE FUNCTION public.claim_due_agents(p_limit int) RETURNS SETOF public.agents LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN IF p_limit IS NULL OR p_limit<=0 OR p_limit>50 THEN RAISE EXCEPTION 'invalid batch limit'; END IF; RETURN QUERY WITH due AS (SELECT id FROM public.agents WHERE state IN ('active','degraded','inactive') AND (claim_expires_at IS NULL OR claim_expires_at<now()) AND (last_completed_at IS NULL OR last_completed_at<now()-(cadence_hours*interval '1 hour')) AND (state<>'inactive' OR last_completed_at IS NULL OR last_completed_at<now()-(cadence_hours*2*interval '1 hour')) ORDER BY last_completed_at NULLS FIRST LIMIT p_limit FOR UPDATE SKIP LOCKED) UPDATE public.agents a SET last_claimed_at=now(),claim_expires_at=now()+interval '30 minutes' FROM due WHERE a.id=due.id RETURNING a.*; END $$;
REVOKE ALL ON FUNCTION public.claim_due_agents(int) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_agents(int) TO service_role;
CREATE OR REPLACE FUNCTION public.release_agent_lease(p_agent_id uuid,p_items_kept int DEFAULT 0) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN UPDATE public.agents SET last_completed_at=now(),claim_expires_at=null,last_useful_at=CASE WHEN p_items_kept>0 THEN now() ELSE last_useful_at END WHERE id=p_agent_id; END $$;
REVOKE ALL ON FUNCTION public.release_agent_lease(uuid,int) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.release_agent_lease(uuid,int) TO service_role;
CREATE OR REPLACE FUNCTION public.update_agent_lifecycle_state(p_agent_id uuid,p_status text,p_items_kept int DEFAULT 0) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE v_state public.agent_state_enum; v_last_useful timestamptz; BEGIN SELECT state,last_useful_at INTO v_state,v_last_useful FROM public.agents WHERE id=p_agent_id; IF NOT FOUND THEN RETURN; END IF; IF p_status='ok' AND p_items_kept>0 THEN UPDATE public.agents SET consecutive_failures=0,state=CASE WHEN v_state IN ('degraded','inactive') THEN 'active'::public.agent_state_enum ELSE v_state END WHERE id=p_agent_id; ELSIF p_status='failed' THEN UPDATE public.agents SET consecutive_failures=consecutive_failures+1,state=CASE WHEN consecutive_failures+1>=20 THEN 'error'::public.agent_state_enum WHEN consecutive_failures+1>=5 THEN 'degraded'::public.agent_state_enum ELSE v_state END WHERE id=p_agent_id; ELSIF p_status='ok' AND p_items_kept=0 THEN UPDATE public.agents SET state=CASE WHEN v_state='active' AND (v_last_useful IS NULL OR v_last_useful<now()-interval '30 days') THEN 'inactive'::public.agent_state_enum ELSE v_state END WHERE id=p_agent_id; END IF; END $$;
REVOKE ALL ON FUNCTION public.update_agent_lifecycle_state(uuid,text,int) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.update_agent_lifecycle_state(uuid,text,int) TO service_role;
-- Owner UUIDs intentionally have no new auth.users foreign keys (Cloud convention).
CREATE TABLE IF NOT EXISTS public.relay_missions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, device_id uuid NOT NULL REFERENCES public.relay_devices(id) ON DELETE CASCADE, mission_id text NOT NULL, agent_id uuid NOT NULL UNIQUE REFERENCES public.agents(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(device_id,mission_id)
);
GRANT ALL ON public.relay_missions TO service_role;
REVOKE ALL ON public.relay_missions FROM public,anon,authenticated;
ALTER TABLE public.relay_missions ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS relay_missions_user_idx ON public.relay_missions(user_id);
create or replace function public.relay_mission_upsert(p_device uuid, p_mission_id text, p_name text, p_config jsonb, p_hours int, p_paused boolean, p_badge text, p_budget jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare dev relay_devices%rowtype; m relay_missions%rowtype; running int; total int; aid uuid; st text;
begin
  select * into dev from relay_devices where id = p_device and revoked_at is null for update;
  if not found then
    return jsonb_build_object('status', 'revoked');
  end if;
  select * into m from relay_missions where device_id = p_device and mission_id = p_mission_id;
  select count(*) into running from relay_missions r join agents a on a.id = r.agent_id
    where r.device_id = p_device and r.mission_id <> p_mission_id and a.state not in ('paused', 'archived');
  if not p_paused and running >= 3 then
    return jsonb_build_object('status', 'too_many');
  end if;
  if m.id is null then
    select count(*) into total from relay_missions where device_id = p_device;
    if total >= 10 then
      return jsonb_build_object('status', 'too_many');
    end if;
    insert into agents (user_id, template_id, display_name, config, badge, state, cadence_hours, budget)
      values (dev.user_id, 'research_digest', p_name, p_config, p_badge,
              (case when p_paused then 'paused' else 'active' end)::agent_state_enum, p_hours, p_budget)
      returning id, state::text into aid, st;
    insert into relay_missions (user_id, device_id, mission_id, agent_id) values (dev.user_id, p_device, p_mission_id, aid);
  else
    update agents set display_name = p_name, config = config || jsonb_build_object('topics', p_config->'topics'),
        cadence_hours = p_hours,
        consecutive_failures = case when not p_paused and state in ('error', 'needs_user_attention') then 0 else consecutive_failures end,
        state = (case when p_paused then 'paused'
                      when state in ('paused', 'draft', 'error', 'needs_user_attention') then 'active'
                      else state::text end)::agent_state_enum
      where id = m.agent_id and user_id = dev.user_id
      returning state::text into st;
    update relay_missions set updated_at = now() where id = m.id;
  end if;
  return jsonb_build_object('status', 'ok', 'agentState', st);
end $$;
create or replace function public.relay_mission_delete(p_device uuid, p_mission_id text) returns boolean language plpgsql security definer set search_path = public as $$
declare aid uuid;
begin
  select agent_id into aid from relay_missions where device_id = p_device and mission_id = p_mission_id;
  if aid is null then
    return false;
  end if;
  delete from agents where id = aid;
  return true;
end $$;
create or replace function public.relay_mission_runs(p_device uuid, p_since timestamptz) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'runs', coalesce((select jsonb_agg(jsonb_build_object('missionId', x.mission_id, 'agentId', x.agent_id, 'runId', x.id,
                                                          'finishedAt', x.finished_at, 'itemsKept', x.items_kept, 'briefing', x.briefing)
                                       order by x.finished_at, x.id)
                      from (select r.id, r.agent_id, r.finished_at, r.items_kept, r.briefing, m.mission_id
                            from relay_missions m join agent_runs r on r.agent_id = m.agent_id
                            where m.device_id = p_device and r.finished_at > p_since and r.status in ('ok', 'partial_success')
                            order by r.finished_at, r.id limit 20) x), '[]'::jsonb),
    'states', coalesce((select jsonb_object_agg(m.mission_id, a.state) from relay_missions m join agents a on a.id = m.agent_id
                        where m.device_id = p_device), '{}'::jsonb))
$$;
create or replace function public.relay_revoke(p_device uuid) returns boolean language plpgsql security definer set search_path = public as $$
begin
  update relay_devices set revoked_at = now() where id = p_device and revoked_at is null;
  if not found then
    return false;
  end if;
  delete from relay_cards where device_id = p_device;
  delete from agents where id in (select agent_id from relay_missions where device_id = p_device);
  return true;
end $$;
REVOKE EXECUTE ON FUNCTION public.relay_mission_upsert(uuid,text,text,jsonb,int,boolean,text,jsonb) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.relay_mission_upsert(uuid,text,text,jsonb,int,boolean,text,jsonb) TO service_role;
REVOKE EXECUTE ON FUNCTION public.relay_mission_delete(uuid,text) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.relay_mission_delete(uuid,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.relay_mission_runs(uuid,timestamptz) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.relay_mission_runs(uuid,timestamptz) TO service_role;
REVOKE EXECUTE ON FUNCTION public.relay_revoke(uuid) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.relay_revoke(uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.delete_agents_for_removed_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN DELETE FROM public.agents WHERE user_id=old.id; RETURN old; END $$;
REVOKE ALL ON FUNCTION public.delete_agents_for_removed_user() FROM public,anon,authenticated;
DROP TRIGGER IF EXISTS delete_agents_on_auth_user ON auth.users;
CREATE TRIGGER delete_agents_on_auth_user BEFORE DELETE ON auth.users FOR EACH ROW EXECUTE FUNCTION public.delete_agents_for_removed_user();
NOTIFY pgrst, 'reload schema';