do $migration$
declare
  definition text;
  anchor text;
  found int;
  anchors text[] := array['relay_answer_log_deleted integer)', 'ral_count int := 0;',
                          'delete from public.relay_lists where user_id = target_user_id;', 'ca_count, ra_count, ral_count;'];
begin
  select pg_get_functiondef('public.delete_user_data(uuid)'::regprocedure) into definition;
  if definition like '%relay_lists_deleted%' then
    return;
  end if;
  foreach anchor in array anchors loop
    found := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
    if found <> 1 then
      raise exception 'delete_user_data is not as expected: "%" found % times. Nothing was changed.', anchor, found;
    end if;
  end loop;
  definition := replace(definition, 'relay_answer_log_deleted integer)', 'relay_answer_log_deleted integer, relay_lists_deleted integer)');
  definition := replace(definition, 'ral_count int := 0;', 'ral_count int := 0; rl_count int := 0;');
  definition := replace(definition, 'delete from public.relay_lists where user_id = target_user_id;',
                        'delete from public.relay_lists where user_id = target_user_id; get diagnostics rl_count = row_count;');
  definition := replace(definition, 'ca_count, ra_count, ral_count;', 'ca_count, ra_count, ral_count, rl_count;');
  execute 'drop function public.delete_user_data(uuid)';
  execute definition;
end $migration$;
revoke execute on function public.delete_user_data(uuid) from public, anon, authenticated;
grant execute on function public.delete_user_data(uuid) to service_role;