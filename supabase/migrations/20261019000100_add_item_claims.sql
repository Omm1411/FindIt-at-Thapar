-- Add a private, owner-reviewed claim workflow for found items.
-- Apply manually to the intended Supabase project after review.

do $$
declare
  existing_constraint record;
begin
  for existing_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.items'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
      and pg_get_constraintdef(oid) ilike '%open%'
      and pg_get_constraintdef(oid) ilike '%resolved%'
  loop
    execute format('alter table public.items drop constraint %I', existing_constraint.conname);
  end loop;
end $$;

alter table public.items
  add constraint items_status_claim_check
  check (status in ('open', 'claimed', 'resolved'));

create table public.item_claims (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id) on delete cascade,
  claimant_user_id uuid not null references auth.users(id) on delete cascade,
  explanation text not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint item_claims_explanation_length_check
    check (char_length(btrim(explanation)) between 1 and 500),
  constraint item_claims_status_check
    check (status in ('pending', 'approved', 'rejected')),
  constraint item_claims_decision_time_check
    check ((status = 'pending' and decided_at is null) or (status <> 'pending' and decided_at is not null))
);

create index item_claims_claimant_created_idx
  on public.item_claims (claimant_user_id, created_at desc);
create index item_claims_item_status_created_idx
  on public.item_claims (item_id, status, created_at desc);
create unique index item_claims_one_active_per_claimant_idx
  on public.item_claims (item_id, claimant_user_id)
  where status in ('pending', 'approved');
create unique index item_claims_one_approval_per_item_idx
  on public.item_claims (item_id)
  where status = 'approved';

alter table public.item_claims enable row level security;
revoke all on public.item_claims from public, anon, authenticated;
grant select on public.item_claims to authenticated;
grant all on public.item_claims to service_role;

create or replace function public.can_view_item_claim(p_item_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.items i
    where i.id = p_item_id and i.user_id = auth.uid()
  );
$$;
revoke all on function public.can_view_item_claim(uuid) from public, anon;
grant execute on function public.can_view_item_claim(uuid) to authenticated;

create policy item_claims_private_select
  on public.item_claims
  for select
  to authenticated
  using (
    claimant_user_id = (select auth.uid())
    or public.can_view_item_claim(item_id)
  );

create or replace function public.reject_ineligible_item_claims()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.type <> 'found' and exists (
    select 1 from public.item_claims c
    where c.item_id = new.id and c.status = 'approved'
  ) then
    raise exception using errcode = '55000', message = 'An approved claim must remain attached to a found listing.';
  end if;

  if (new.status <> 'open' or new.type <> 'found' or new.user_id is null)
     and (old.status = 'open' and old.type = 'found' and old.user_id is not null) then
    update public.item_claims
       set status = 'rejected', decided_at = now()
     where item_id = new.id and status = 'pending';
  end if;
  return new;
end;
$$;

create trigger reject_ineligible_item_claims_after_item_update
  after update of status, type, user_id on public.items
  for each row
  execute function public.reject_ineligible_item_claims();
revoke all on function public.reject_ineligible_item_claims() from public, anon, authenticated;

create or replace function public.submit_item_claim(
  p_item_id uuid,
  p_claimant_user_id uuid,
  p_explanation text
)
returns public.item_claims
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_item public.items;
  v_claim public.item_claims;
begin
  if p_item_id is null or p_claimant_user_id is null
     or p_explanation is null
     or char_length(btrim(p_explanation)) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'Invalid claim details.';
  end if;

  select * into v_item
    from public.items
   where id = p_item_id
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Listing not found.';
  end if;
  if v_item.user_id is null or v_item.user_id = p_claimant_user_id then
    raise exception using errcode = '42501', message = 'Claim is not allowed.';
  end if;
  if v_item.type <> 'found' or v_item.status <> 'open' then
    raise exception using errcode = '55000', message = 'Listing is not eligible for claims.';
  end if;

  insert into public.item_claims (item_id, claimant_user_id, explanation)
  values (p_item_id, p_claimant_user_id, btrim(p_explanation))
  returning * into v_claim;
  return v_claim;
end;
$$;

create or replace function public.decide_item_claim(
  p_claim_id uuid,
  p_actor_user_id uuid,
  p_decision text
)
returns public.item_claims
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_item_id uuid;
  v_item public.items;
  v_claim public.item_claims;
begin
  if p_claim_id is null or p_actor_user_id is null or p_decision is null
     or p_decision not in ('approved', 'rejected') then
    raise exception using errcode = '22023', message = 'Invalid claim decision.';
  end if;

  select item_id into v_item_id
    from public.item_claims
   where id = p_claim_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Claim not found.';
  end if;

  -- All submission and decision paths lock the listing first, serializing decisions per item.
  select * into v_item
    from public.items
   where id = v_item_id
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Listing not found.';
  end if;

  select * into v_claim
    from public.item_claims
   where id = p_claim_id and item_id = v_item_id
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Claim not found.';
  end if;
  if v_claim.claimant_user_id = p_actor_user_id or v_item.user_id is distinct from p_actor_user_id then
    raise exception using errcode = '42501', message = 'Claim review is not allowed.';
  end if;
  if v_claim.status <> 'pending' then
    raise exception using errcode = '55000', message = 'Claim is no longer pending.';
  end if;
  if v_item.type <> 'found' or v_item.status <> 'open' then
    raise exception using errcode = '55000', message = 'Listing is no longer eligible.';
  end if;

  update public.item_claims
     set status = p_decision, decided_at = now()
   where id = p_claim_id
   returning * into v_claim;

  if p_decision = 'approved' then
    update public.items set status = 'claimed' where id = v_item_id;
    -- The item trigger rejects any competing pending claims in this same transaction.
  end if;
  return v_claim;
end;
$$;

revoke all on function public.submit_item_claim(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.decide_item_claim(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.submit_item_claim(uuid, uuid, text) to service_role;
grant execute on function public.decide_item_claim(uuid, uuid, text) to service_role;
