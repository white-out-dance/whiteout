-- Whiteout Supabase schema (paste into Supabase SQL Editor and run).
-- This enables DJ auth via Supabase Auth, party creation, DJ claiming/heartbeat,
-- and guest song requests via RPC (no direct table access for guests).

-- Supabase installs many extensions into the `extensions` schema.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- Core tables
create table if not exists public.parties (
  id uuid primary key default extensions.gen_random_uuid(),
  code text not null unique,
  name text,
  status text not null default 'live',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '12 hours'),
  owner_id uuid references auth.users(id) on delete cascade,
  dj_key_hash text not null,
  active_dj_session_id uuid
);

-- If you are applying this schema to an existing project, `create table if not exists` will not
-- add new columns. Ensure the party name column exists for older installs.
alter table public.parties
  add column if not exists name text;

create table if not exists public.dj_sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  party_id uuid not null references public.parties(id) on delete cascade,
  token_hash text not null,
  device_name text not null,
  active boolean not null default true,
  heartbeat_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.parties
  add constraint parties_active_session_fkey
  foreign key (active_dj_session_id) references public.dj_sessions(id)
  on delete set null on update cascade;

create index if not exists dj_sessions_party_active_idx on public.dj_sessions(party_id, active);
create index if not exists parties_owner_idx on public.parties(owner_id);

create table if not exists public.song_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  party_id uuid not null references public.parties(id) on delete cascade,
  seq_no int not null default 0,
  title text not null,
  artist text not null,
  service text not null,
  song_url text,
  status text not null default 'queued',
  played_at timestamptz,
  played_by text,
  created_at timestamptz not null default now(),
  unique (party_id, seq_no)
);

create index if not exists song_requests_party_created_idx on public.song_requests(party_id, created_at);
create index if not exists song_requests_party_status_seq_idx on public.song_requests(party_id, status, seq_no);

create table if not exists public.request_votes (
  id uuid primary key default extensions.gen_random_uuid(),
  party_id uuid not null references public.parties(id) on delete cascade,
  request_id uuid not null references public.song_requests(id) on delete cascade,
  guest_token text not null,
  value int not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (request_id, guest_token)
);

create index if not exists request_votes_party_request_idx on public.request_votes(party_id, request_id);
create index if not exists request_votes_request_value_idx on public.request_votes(request_id, value);

create table if not exists public.idempotency_keys (
  id uuid primary key default extensions.gen_random_uuid(),
  party_id uuid not null references public.parties(id) on delete cascade,
  key text not null,
  request_id uuid not null references public.song_requests(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (party_id, key)
);

create index if not exists idempotency_request_idx on public.idempotency_keys(request_id);

-- Basic constraints
alter table public.parties
  add constraint parties_code_format_chk
  check (code ~ '^[A-Z0-9]{6}$');

alter table public.song_requests
  add constraint song_requests_title_len_chk
  check (char_length(title) between 1 and 120);

alter table public.song_requests
  add constraint song_requests_artist_len_chk
  check (char_length(artist) between 1 and 120);

alter table public.song_requests
  add constraint song_requests_service_chk
  check (service in ('Apple Music', 'Spotify', 'SoundCloud'));

alter table public.song_requests
  drop constraint if exists song_requests_status_chk;

alter table public.song_requests
  add constraint song_requests_status_chk
  check (status in ('queued', 'approved', 'played', 'rejected'));

alter table public.song_requests
  add constraint song_requests_song_url_chk
  check (song_url is null or song_url = '' or song_url ~ '^https://');

alter table public.request_votes
  drop constraint if exists request_votes_value_chk;

alter table public.request_votes
  add constraint request_votes_value_chk
  check (value in (-1, 1));

-- RLS: default deny. All guest traffic uses RPC.
alter table public.parties enable row level security;
alter table public.dj_sessions enable row level security;
alter table public.song_requests enable row level security;
alter table public.idempotency_keys enable row level security;
alter table public.request_votes enable row level security;

-- Allow authenticated DJs to list their own parties (optional convenience).
drop policy if exists parties_owner_select on public.parties;
create policy parties_owner_select
on public.parties
for select
to authenticated
using (owner_id = auth.uid());

-- Helper functions
create or replace function public.sha256_hex(p_text text)
returns text
language sql
immutable
as $$
  -- pgcrypto.digest expects bytea input
  select encode(extensions.digest(convert_to(coalesce(p_text,''), 'utf8'), 'sha256'::text), 'hex')
$$;

create or replace function public.normalize_party_code(p_text text)
returns text
language sql
immutable
as $$
  select left(regexp_replace(upper(coalesce(p_text,'')), '[^A-Z0-9]', '', 'g'), 6)
$$;

create or replace function public.random_code(p_length int)
returns text
language plpgsql
volatile
as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  out text := '';
  i int := 0;
begin
  if p_length is null or p_length < 1 then
    return '';
  end if;

  for i in 1..p_length loop
    out := out || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;

  return out;
end;
$$;

-- Automatically assign seq_no per party.
create or replace function public.assign_request_seq_no()
returns trigger
language plpgsql
as $$
declare
  next_seq int;
begin
  if new.seq_no is null or new.seq_no <= 0 then
    select coalesce(max(seq_no), 0) + 1
      into next_seq
      from public.song_requests
     where party_id = new.party_id;

    new.seq_no := next_seq;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_assign_request_seq_no on public.song_requests;
create trigger trg_assign_request_seq_no
before insert on public.song_requests
for each row
execute function public.assign_request_seq_no();

-- Core RPC: DJ creates a party (requires Supabase Auth login).
create or replace function public.create_party(p_name text default null)
returns table(code text, dj_key text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid := auth.uid();
  party_code text;
  dj_key_plain text;
  inserted boolean := false;
  party_name text := nullif(left(trim(regexp_replace(coalesce(p_name,''), '\s+', ' ', 'g')), 80), '');
  last_created_at timestamptz;
begin
  if owner is null then
    raise exception 'Not authenticated';
  end if;

  if party_name is null then
    raise exception 'Party name is required';
  end if;

  select max(created_at) into last_created_at
    from public.parties
   where owner_id = owner;

  if last_created_at is not null and last_created_at > now() - interval '60 seconds' then
    raise exception 'Please wait before creating another party';
  end if;

  for i in 1..30 loop
    party_code := public.random_code(6);
    dj_key_plain := public.random_code(10);

    begin
      insert into public.parties(code, name, owner_id, expires_at, dj_key_hash)
      values (party_code, party_name, owner, now() + interval '12 hours', public.sha256_hex(dj_key_plain));

      inserted := true;
      exit;
    exception when unique_violation then
      -- retry
    end;
  end loop;

  if not inserted then
    raise exception 'Could not create party';
  end if;

  code := party_code;
  dj_key := dj_key_plain;
  select p.expires_at into expires_at from public.parties p where p.code = party_code;
  return next;
end;
$$;

-- DJ app claims the booth (uses party code + DJ key).
create or replace function public.claim_dj(p_code text, p_dj_key text, p_device_name text)
returns table(session_id uuid, dj_token text, party_code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  code_norm text := public.normalize_party_code(p_code);
  dj_key_clean text := regexp_replace(coalesce(p_dj_key,''), '\s+', '', 'g');
  party_row public.parties%rowtype;
  token_plain text;
  session_row public.dj_sessions%rowtype;
begin
  if code_norm !~ '^[A-Z0-9]{6}$' then
    raise exception 'Invalid party code';
  end if;

  if dj_key_clean = '' then
    raise exception 'Invalid DJ key';
  end if;

  select * into party_row from public.parties where code = code_norm;
  if not found then
    raise exception 'Party not found';
  end if;

  if party_row.expires_at <= now() then
    raise exception 'Party expired';
  end if;

  if party_row.dj_key_hash <> public.sha256_hex(dj_key_clean) then
    raise exception 'Invalid DJ key';
  end if;

  token_plain := encode(extensions.gen_random_bytes(32), 'hex');

  update public.dj_sessions
     set active = false
   where party_id = party_row.id and active = true;

  insert into public.dj_sessions(party_id, token_hash, device_name, active, heartbeat_at)
  values (party_row.id, public.sha256_hex(token_plain), coalesce(nullif(trim(p_device_name),''), 'DJ Macbook'), true, now())
  returning * into session_row;

  update public.parties
     set active_dj_session_id = session_row.id
   where id = party_row.id;

  session_id := session_row.id;
  dj_token := token_plain;
  party_code := party_row.code;
  expires_at := party_row.expires_at;
  return next;
end;
$$;

create or replace function public.dj_heartbeat(p_code text, p_session_id uuid, p_dj_token text)
returns table(ok boolean, heartbeat_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  code_norm text := public.normalize_party_code(p_code);
  token_clean text := trim(coalesce(p_dj_token,''));
  party_id_value uuid;
  session_row public.dj_sessions%rowtype;
begin
  if code_norm !~ '^[A-Z0-9]{6}$' then
    raise exception 'Invalid party code';
  end if;

  if p_session_id is null or token_clean = '' then
    raise exception 'Missing DJ credentials';
  end if;

  select id into party_id_value from public.parties where code = code_norm;
  if party_id_value is null then
    raise exception 'Party not found';
  end if;

  select * into session_row
    from public.dj_sessions
   where id = p_session_id and party_id = party_id_value and active = true;

  if not found then
    raise exception 'Invalid DJ session';
  end if;

  if session_row.token_hash <> public.sha256_hex(token_clean) then
    raise exception 'Invalid DJ token';
  end if;

  update public.dj_sessions
     set heartbeat_at = now(),
         active = true
   where id = session_row.id
   returning heartbeat_at into heartbeat_at;

  ok := true;
  return next;
end;
$$;

-- Guest join status (no auth).
create or replace function public.join_party(p_code text)
returns table(ok boolean, party_code text, party_name text, expires_at timestamptz, dj_active boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  code_norm text := public.normalize_party_code(p_code);
  party_row public.parties%rowtype;
  session_row public.dj_sessions%rowtype;
begin
  if code_norm !~ '^[A-Z0-9]{6}$' then
    ok := false;
    return next;
    return;
  end if;

  select * into party_row from public.parties where code = code_norm;
  if not found then
    ok := false;
    return next;
    return;
  end if;

  ok := true;
  party_code := party_row.code;
  party_name := party_row.name;
  expires_at := party_row.expires_at;

  if party_row.expires_at <= now() then
    dj_active := false;
    return next;
    return;
  end if;

  -- Consider any active DJ session for this party as "DJ connected" so guests don't get stuck
  -- if `active_dj_session_id` is missing/outdated.
  select * into session_row
    from public.dj_sessions s
   where s.party_id = party_row.id
     and s.active = true
   order by s.heartbeat_at desc
   limit 1;

  if not found then
    dj_active := false;
  else
    dj_active := session_row.heartbeat_at > now() - interval '35 seconds';
  end if;
  return next;
end;
$$;

-- Guest submit request (no auth). Enforces DJ active + idempotency.
create or replace function public.submit_request(
  p_code text,
  p_service text,
  p_title text,
  p_artist text,
  p_song_url text,
  p_idempotency_key text
)
returns table(
  id uuid,
  seq_no int,
  title text,
  artist text,
  service text,
  song_url text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  code_norm text := public.normalize_party_code(p_code);
  svc text := trim(coalesce(p_service,''));
  t text := left(trim(regexp_replace(coalesce(p_title,''), '\s+', ' ', 'g')), 120);
  a text := left(trim(regexp_replace(coalesce(p_artist,''), '\s+', ' ', 'g')), 120);
  url text := left(trim(coalesce(p_song_url,'')), 500);
  idem text := left(trim(coalesce(p_idempotency_key,'')), 80);
  party_row public.parties%rowtype;
  session_row public.dj_sessions%rowtype;
  request_row public.song_requests%rowtype;
  existing_key public.idempotency_keys%rowtype;
begin
  if code_norm !~ '^[A-Z0-9]{6}$' then
    raise exception 'Invalid party code';
  end if;

  if svc not in ('Apple Music','Spotify','SoundCloud') then
    raise exception 'Unsupported music service';
  end if;

  if t = '' or a = '' then
    raise exception 'Invalid request payload';
  end if;

  if url <> '' and url !~ '^https://' then
    raise exception 'Invalid song URL';
  end if;

  select * into party_row from public.parties where code = code_norm;
  if not found then
    raise exception 'Party not found';
  end if;

  if party_row.expires_at <= now() then
    raise exception 'Party expired';
  end if;

  if party_row.active_dj_session_id is null then
    raise exception 'DJ is not active for this party';
  end if;

  select * into session_row from public.dj_sessions where id = party_row.active_dj_session_id;
  if not found then
    raise exception 'DJ is not active for this party';
  end if;

  if not (session_row.active and session_row.heartbeat_at > now() - interval '35 seconds') then
    raise exception 'DJ is not active for this party';
  end if;

  if idem <> '' then
    select * into existing_key from public.idempotency_keys where party_id = party_row.id and key = idem;
    if found then
      select * into request_row from public.song_requests r where r.id = existing_key.request_id;
      id := request_row.id;
      seq_no := request_row.seq_no;
      title := request_row.title;
      artist := request_row.artist;
      service := request_row.service;
      song_url := coalesce(request_row.song_url,'');
      created_at := request_row.created_at;
      return next;
      return;
    end if;
  end if;

  insert into public.song_requests(party_id, title, artist, service, song_url)
  values (party_row.id, t, a, svc, url)
  returning * into request_row;

  if idem <> '' then
    insert into public.idempotency_keys(party_id, key, request_id)
    values (party_row.id, idem, request_row.id);
  end if;

  id := request_row.id;
  seq_no := request_row.seq_no;
  title := request_row.title;
  artist := request_row.artist;
  service := request_row.service;
  song_url := coalesce(request_row.song_url,'');
  created_at := request_row.created_at;
  return next;
end;
$$;

create or replace function public.guest_list_requests(p_code text, p_guest_token text default null)
returns table(
  id uuid,
  seq_no int,
  title text,
  artist text,
  service text,
  status text,
  played_at timestamptz,
  played_by text,
  created_at timestamptz,
  upvotes int,
  downvotes int,
  score int,
  my_vote int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  code_norm text := public.normalize_party_code(p_code);
  guest_token_clean text := left(trim(coalesce(p_guest_token,'')), 120);
  party_row public.parties%rowtype;
begin
  if code_norm !~ '^[A-Z0-9]{6}$' then
    raise exception 'Invalid party code';
  end if;

  select * into party_row from public.parties where code = code_norm;
  if not found then
    raise exception 'Party not found';
  end if;

  return query
  with vote_totals as (
    select
      v.request_id,
      count(*) filter (where v.value = 1)::int as upvotes,
      count(*) filter (where v.value = -1)::int as downvotes
    from public.request_votes v
    where v.party_id = party_row.id
    group by v.request_id
  ),
  my_votes as (
    select v.request_id, v.value::int as my_vote
      from public.request_votes v
     where guest_token_clean <> ''
       and v.party_id = party_row.id
       and v.guest_token = guest_token_clean
  )
  select
    r.id,
    r.seq_no,
    r.title,
    r.artist,
    r.service,
    r.status,
    r.played_at,
    r.played_by,
    r.created_at,
    coalesce(vt.upvotes, 0)::int as upvotes,
    coalesce(vt.downvotes, 0)::int as downvotes,
    (coalesce(vt.upvotes, 0) - coalesce(vt.downvotes, 0))::int as score,
    coalesce(mv.my_vote, 0)::int as my_vote
  from public.song_requests r
  left join vote_totals vt on vt.request_id = r.id
  left join my_votes mv on mv.request_id = r.id
  where r.party_id = party_row.id
  order by r.created_at desc, r.seq_no desc
  limit 40;
end;
$$;

-- DJ RPC: list requests (token-based, for the DJ desktop app).
create or replace function public.dj_list_requests(p_code text, p_session_id uuid, p_dj_token text)
returns table(
  id uuid,
  seq_no int,
  title text,
  artist text,
  service text,
  song_url text,
  status text,
  played_at timestamptz,
  played_by text,
  created_at timestamptz,
  upvotes int,
  downvotes int,
  score int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  code_norm text := public.normalize_party_code(p_code);
  token_clean text := trim(coalesce(p_dj_token,''));
  party_id_value uuid;
  session_token_hash text;
begin
  if code_norm !~ '^[A-Z0-9]{6}$' then
    raise exception 'Invalid party code';
  end if;

  if p_session_id is null or token_clean = '' then
    raise exception 'Missing DJ credentials';
  end if;

  select p.id
    into party_id_value
    from public.parties p
   where p.code = code_norm;
  if party_id_value is null then
    raise exception 'Party not found';
  end if;

  select s.token_hash
    into session_token_hash
    from public.dj_sessions s
   where s.id = p_session_id
     and s.party_id = party_id_value
     and s.active = true;
  if session_token_hash is null then
    raise exception 'Invalid DJ session';
  end if;

  if session_token_hash <> public.sha256_hex(token_clean) then
    raise exception 'Invalid DJ token';
  end if;

  return query
  with vote_totals as (
    select
      v.request_id,
      count(*) filter (where v.value = 1)::int as upvotes,
      count(*) filter (where v.value = -1)::int as downvotes
    from public.request_votes v
    where v.party_id = party_id_value
    group by v.request_id
  )
  select *
    from (
      select
        r.id as request_id,
        r.seq_no as request_seq_no,
        r.title as request_title,
        r.artist as request_artist,
        r.service as request_service,
        coalesce(r.song_url,'') as request_song_url,
        r.status as request_status,
        r.played_at as request_played_at,
        r.played_by as request_played_by,
        r.created_at as request_created_at,
        coalesce(vt.upvotes, 0)::int as request_upvotes,
        coalesce(vt.downvotes, 0)::int as request_downvotes,
        (coalesce(vt.upvotes, 0) - coalesce(vt.downvotes, 0))::int as request_score
      from public.song_requests r
      left join vote_totals vt on vt.request_id = r.id
      where r.party_id = party_id_value
      order by r.seq_no asc
    ) ranked_requests(
      id,
      seq_no,
      title,
      artist,
      service,
      song_url,
      status,
      played_at,
      played_by,
      created_at,
      upvotes,
      downvotes,
      score
    );
end;
$$;

create or replace function public.dj_mark_played(p_code text, p_request_id uuid, p_session_id uuid, p_dj_token text)
returns table(ok boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  code_norm text := public.normalize_party_code(p_code);
  token_clean text := trim(coalesce(p_dj_token,''));
  party_row public.parties%rowtype;
  session_row public.dj_sessions%rowtype;
  device text;
begin
  if code_norm !~ '^[A-Z0-9]{6}$' then
    raise exception 'Invalid party code';
  end if;
  if p_request_id is null then
    raise exception 'Invalid request ID';
  end if;
  if p_session_id is null or token_clean = '' then
    raise exception 'Missing DJ credentials';
  end if;

  select * into party_row from public.parties where code = code_norm;
  if not found then
    raise exception 'Party not found';
  end if;

  select * into session_row from public.dj_sessions where id = p_session_id and party_id = party_row.id and active = true;
  if not found then
    raise exception 'Invalid DJ session';
  end if;
  if session_row.token_hash <> public.sha256_hex(token_clean) then
    raise exception 'Invalid DJ token';
  end if;

  device := session_row.device_name;
  update public.song_requests
     set status = 'played',
         played_at = now(),
         played_by = device
   where id = p_request_id and party_id = party_row.id;

  ok := true;
  return next;
end;
$$;

create or replace function public.dj_mark_approved(p_code text, p_request_id uuid, p_session_id uuid, p_dj_token text)
returns table(ok boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  code_norm text := public.normalize_party_code(p_code);
  token_clean text := trim(coalesce(p_dj_token,''));
  party_row public.parties%rowtype;
  session_row public.dj_sessions%rowtype;
  device text;
begin
  if code_norm !~ '^[A-Z0-9]{6}$' then
    raise exception 'Invalid party code';
  end if;
  if p_request_id is null then
    raise exception 'Invalid request ID';
  end if;
  if p_session_id is null or token_clean = '' then
    raise exception 'Missing DJ credentials';
  end if;

  select * into party_row from public.parties where code = code_norm;
  if not found then
    raise exception 'Party not found';
  end if;

  select * into session_row from public.dj_sessions where id = p_session_id and party_id = party_row.id and active = true;
  if not found then
    raise exception 'Invalid DJ session';
  end if;
  if session_row.token_hash <> public.sha256_hex(token_clean) then
    raise exception 'Invalid DJ token';
  end if;

  device := session_row.device_name;
  update public.song_requests
     set status = 'approved',
         played_at = now(),
         played_by = device
   where id = p_request_id and party_id = party_row.id;

  ok := true;
  return next;
end;
$$;

create or replace function public.dj_mark_queued(p_code text, p_request_id uuid, p_session_id uuid, p_dj_token text)
returns table(ok boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  code_norm text := public.normalize_party_code(p_code);
  token_clean text := trim(coalesce(p_dj_token,''));
  party_row public.parties%rowtype;
  session_row public.dj_sessions%rowtype;
begin
  if code_norm !~ '^[A-Z0-9]{6}$' then
    raise exception 'Invalid party code';
  end if;
  if p_request_id is null then
    raise exception 'Invalid request ID';
  end if;
  if p_session_id is null or token_clean = '' then
    raise exception 'Missing DJ credentials';
  end if;

  select * into party_row from public.parties where code = code_norm;
  if not found then
    raise exception 'Party not found';
  end if;

  select * into session_row from public.dj_sessions where id = p_session_id and party_id = party_row.id and active = true;
  if not found then
    raise exception 'Invalid DJ session';
  end if;
  if session_row.token_hash <> public.sha256_hex(token_clean) then
    raise exception 'Invalid DJ token';
  end if;

  update public.song_requests
     set status = 'queued',
         played_at = null,
         played_by = null
   where id = p_request_id and party_id = party_row.id;

  ok := true;
  return next;
end;
$$;

create or replace function public.dj_mark_rejected(p_code text, p_request_id uuid, p_session_id uuid, p_dj_token text)
returns table(ok boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  code_norm text := public.normalize_party_code(p_code);
  token_clean text := trim(coalesce(p_dj_token,''));
  party_row public.parties%rowtype;
  session_row public.dj_sessions%rowtype;
  device text;
begin
  if code_norm !~ '^[A-Z0-9]{6}$' then
    raise exception 'Invalid party code';
  end if;
  if p_request_id is null then
    raise exception 'Invalid request ID';
  end if;
  if p_session_id is null or token_clean = '' then
    raise exception 'Missing DJ credentials';
  end if;

  select * into party_row from public.parties where code = code_norm;
  if not found then
    raise exception 'Party not found';
  end if;

  select * into session_row from public.dj_sessions where id = p_session_id and party_id = party_row.id and active = true;
  if not found then
    raise exception 'Invalid DJ session';
  end if;
  if session_row.token_hash <> public.sha256_hex(token_clean) then
    raise exception 'Invalid DJ token';
  end if;

  device := session_row.device_name;
  update public.song_requests
     set status = 'rejected',
         played_at = now(),
         played_by = device
   where id = p_request_id and party_id = party_row.id;

  ok := true;
  return next;
end;
$$;

create or replace function public.guest_vote_request(
  p_code text,
  p_request_id uuid,
  p_guest_token text,
  p_value int
)
returns table(ok boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  code_norm text := public.normalize_party_code(p_code);
  guest_token_clean text := left(trim(coalesce(p_guest_token,'')), 120);
  vote_value int := coalesce(p_value, 0);
  party_row public.parties%rowtype;
  request_row public.song_requests%rowtype;
begin
  if code_norm !~ '^[A-Z0-9]{6}$' then
    raise exception 'Invalid party code';
  end if;
  if p_request_id is null then
    raise exception 'Invalid request ID';
  end if;
  if guest_token_clean = '' then
    raise exception 'Invalid guest token';
  end if;
  if vote_value not in (-1, 0, 1) then
    raise exception 'Invalid vote value';
  end if;

  select * into party_row from public.parties where code = code_norm;
  if not found then
    raise exception 'Party not found';
  end if;
  if party_row.expires_at <= now() then
    raise exception 'Party expired';
  end if;

  select * into request_row from public.song_requests where id = p_request_id and party_id = party_row.id;
  if not found then
    raise exception 'Request not found';
  end if;

  if vote_value = 0 then
    delete from public.request_votes
     where request_id = request_row.id
       and guest_token = guest_token_clean;
  else
    insert into public.request_votes(party_id, request_id, guest_token, value)
    values (party_row.id, request_row.id, guest_token_clean, vote_value)
    on conflict (request_id, guest_token)
    do update
       set value = excluded.value,
           updated_at = now();
  end if;

  ok := true;
  return next;
end;
$$;
