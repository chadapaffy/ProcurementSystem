-- ============================================================================
-- ระบบขอเบิกใช้งบประมาณ — ฐานข้อมูล Supabase (Postgres)
--
-- วิธีใช้: เปิด Supabase → SQL Editor → วางไฟล์นี้ทั้งไฟล์ → Run
-- รันซ้ำได้ (idempotent) ใช้ปรับปรุงเวอร์ชันได้โดยไม่ลบข้อมูล
--
-- หลักการความปลอดภัย
--   * ตารางทั้งหมดเปิด Row Level Security และ "ไม่มี policy" + ถอนสิทธิ์ anon/authenticated
--     → เบราว์เซอร์อ่าน/เขียนตารางตรง ๆ ไม่ได้เลย (แม้มี anon key)
--   * ทุกอย่างผ่านฟังก์ชัน app_* (security definer) ซึ่งตรวจ "ผู้ใช้ + สิทธิ์ของบทบาท + สถานะของเอกสาร" ฝั่งเซิร์ฟเวอร์ทุกครั้ง
--   * ผู้ใช้ที่ยังไม่ได้รับบทบาทหรือถูกปิดการใช้งาน เรียกฟังก์ชันข้อมูลไม่ได้
--   * บทบาท (app_roles) กำหนดชุดสิทธิ์ได้ — Admin ปรับสิทธิ์และสร้างบทบาทใหม่ได้ที่หน้า Admin ในเว็บ
-- ============================================================================

-- ---------------------------------------------------------------- types & tables

-- บทบาทและสิทธิ์ (สิทธิ์ต่อบทบาทแก้ได้ที่หน้า Admin)
create table if not exists public.app_roles (
  key          text primary key,                  -- รหัสบทบาท เช่น finance
  name         text not null,
  description  text not null default '',
  permissions  text[] not null default '{}',      -- ดูรายการสิทธิ์ที่ _app_perm_catalog()
  is_system    boolean not null default false,    -- บทบาทตั้งต้น ลบไม่ได้
  created_at   timestamptz not null default now()
);

create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null default '',
  name        text not null default '',
  title       text not null default '',
  department  text not null default '',
  role        text,                               -- null = รอผู้ดูแลกำหนดสิทธิ์
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- อัปเกรดจากเวอร์ชันแรกที่ role เป็น enum (requester/finance/accounting) → text อ้างอิงตาราง app_roles
do $$
begin
  if exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname = 'app_role') then
    drop function if exists public._app_need(public.app_role[]);
    if (select data_type from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'role') = 'USER-DEFINED' then
      alter table public.profiles alter column role type text using role::text;
    end if;
    drop type public.app_role;
  end if;
end $$;

-- บทบาทตั้งต้น (ไม่เขียนทับถ้า Admin แก้สิทธิ์ไว้แล้ว)
insert into public.app_roles (key, name, description, permissions, is_system) values
  ('admin', 'ผู้ดูแลระบบ (Admin)', 'จัดการผู้ใช้ บทบาท สิทธิ์ และข้อมูลหลัก',
    array['budget.view_all', 'master.manage', 'user.manage'], true),
  ('requester', 'ผู้ขอใช้งบ', 'ขอเบิกใช้งบของงบที่ตนเป็นเจ้าของ',
    array['request.create'], true),
  ('finance', 'การเงิน', 'ตั้งและปรับงบ ตรวจสอบ/อนุมัติเอกสาร CAPEX และบันทึกงวดจ่าย',
    array['budget.view_all', 'budget.manage', 'master.manage', 'request.decide', 'payment.record'], true),
  ('accounting', 'บัญชี', 'บันทึกข้อมูลบัญชี: วันที่จ่ายจริง Asset/Expenses และ GL',
    array['budget.view_all', 'accounting.record'], true)
on conflict (key) do nothing;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_role_fkey') then
    alter table public.profiles add constraint profiles_role_fkey foreign key (role) references public.app_roles (key) on update cascade;
  end if;
end $$;

-- ถ้ายังไม่มีผู้ใช้ที่จัดการผู้ใช้/สิทธิ์ได้เลย (เช่น อัปเกรดจากเวอร์ชันแรก) เลื่อนผู้ใช้การเงินที่เก่าที่สุดเป็น Admin
update public.profiles set role = 'admin'
where id = (select id from public.profiles where role = 'finance' and active order by created_at limit 1)
  and not exists (select 1 from public.profiles p join public.app_roles r on r.key = p.role
                  where p.active and 'user.manage' = any (r.permissions));

create table if not exists public.app_master (
  key         text primary key,                -- companies | departments | groups | assetTypes | glCodes
  data        jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

create table if not exists public.app_budgets (
  id          text primary key,
  owner_id    uuid not null references public.profiles (id),
  type        text not null check (type in ('CAPEX', 'CBS')),
  code        text not null unique,
  data        jsonb not null,                  -- โครงสร้างเดียวกับที่หน้าเว็บใช้ (items, revisions ฯลฯ)
  version     integer not null default 1,      -- กันสองคนแก้งบพร้อมกัน
  is_sample   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.app_requests (
  id            text primary key,
  budget_id     text not null references public.app_budgets (id),
  requester_id  uuid not null references public.profiles (id),
  status        text not null check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  data          jsonb not null,
  is_sample     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists app_requests_budget_idx on public.app_requests (budget_id);
create index if not exists app_requests_requester_idx on public.app_requests (requester_id);

create table if not exists public.app_counters (
  key    text primary key,
  value  integer not null default 0
);

-- ปิดการเข้าถึงตารางตรง ๆ: เปิด RLS โดยไม่มี policy และถอนสิทธิ์ทั้งหมด
alter table public.profiles     enable row level security;
alter table public.app_roles    enable row level security;
alter table public.app_master   enable row level security;
alter table public.app_budgets  enable row level security;
alter table public.app_requests enable row level security;
alter table public.app_counters enable row level security;
revoke all on public.profiles, public.app_roles, public.app_master, public.app_budgets, public.app_requests, public.app_counters from anon, authenticated;

-- ---------------------------------------------------------------- new user → profile

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data ->> 'name', split_part(coalesce(new.email, ''), '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ผู้ใช้ที่สร้างไว้ก่อนรันไฟล์นี้
insert into public.profiles (id, email, name)
select u.id, coalesce(u.email, ''), coalesce(u.raw_user_meta_data ->> 'name', split_part(coalesce(u.email, ''), '@', 1))
from auth.users u
on conflict (id) do nothing;

-- ---------------------------------------------------------------- internal helpers (ไม่เปิดให้เบราว์เซอร์เรียก)

create or replace function public._app_user() returns public.profiles
language sql stable security definer set search_path = public as $$
  select p.* from public.profiles p where p.id = auth.uid() and p.active and p.role is not null
$$;

/** รายการสิทธิ์ทั้งหมดของระบบ (เพิ่มสิทธิ์ใหม่ที่นี่และในหน้า Admin) */
create or replace function public._app_perm_catalog() returns text[]
language sql immutable set search_path = public as $$
  select array['budget.view_all', 'request.create', 'request.decide', 'payment.record', 'accounting.record',
               'budget.manage', 'master.manage', 'user.manage']
$$;

create or replace function public._app_perms(p_role text) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce((select r.permissions from public.app_roles r where r.key = p_role), '{}'::text[])
$$;

/** ต้องเป็นผู้ใช้ที่ active มีบทบาท และบทบาทนั้นมีสิทธิ์ p_perm */
create or replace function public._app_need(p_perm text) returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare u public.profiles;
begin
  u := public._app_user();
  if u.id is null then
    raise exception 'ไม่มีสิทธิ์ใช้งาน (ยังไม่ได้รับบทบาท หรือบัญชีถูกปิด)' using errcode = '42501';
  end if;
  if not (p_perm = any (public._app_perms(u.role))) then
    raise exception 'ไม่มีสิทธิ์ทำรายการนี้' using errcode = '42501';
  end if;
  return u;
end $$;

/** เห็นงบและคำขอของทุกคน: มีสิทธิ์ดูทั้งหมด หรือสิทธิ์ที่ต้องเห็นเอกสารของคนอื่น (อนุมัติ งวดจ่าย บัญชี จัดการงบ) */
create or replace function public._app_view_all(p_role text) returns boolean
language sql stable security definer set search_path = public as $$
  select public._app_perms(p_role) && array['budget.view_all', 'budget.manage', 'request.decide', 'payment.record', 'accounting.record']
$$;

/** จำนวนผู้ใช้ที่ใช้งานอยู่และจัดการผู้ใช้/สิทธิ์ได้ (ไม่นับ p_ignore; ถ้าบทบาท p_role ถูกแก้ ใช้สิทธิ์ใหม่ p_perms) */
create or replace function public._app_managers(p_ignore uuid, p_role text, p_perms text[]) returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::integer from public.profiles p left join public.app_roles r on r.key = p.role
  where p.active and (p_ignore is null or p.id <> p_ignore)
    and 'user.manage' = any (case when p.role = p_role then p_perms else coalesce(r.permissions, '{}'::text[]) end)
$$;

create or replace function public._app_iso(p_at timestamptz) returns text
language sql immutable set search_path = public as $$
  select to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

create or replace function public._app_next(p_key text) returns integer
language plpgsql security definer set search_path = public as $$
declare v integer;
begin
  insert into public.app_counters as c (key, value) values (p_key, 1)
  on conflict (key) do update set value = c.value + 1
  returning c.value into v;
  return v;
end $$;

create or replace function public._app_rand(p_prefix text) returns text
language sql volatile set search_path = public as $$
  select p_prefix || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)
$$;

/** เลขที่คำขอ REQ-ปี-ลำดับ (นับใหม่ทุกปี) */
create or replace function public._app_req_no(p_at timestamptz) returns text
language plpgsql security definer set search_path = public as $$
declare y text := to_char(p_at at time zone 'Asia/Bangkok', 'YYYY');
begin
  return 'REQ-' || y || '-' || lpad(public._app_next('req:' || y)::text, 4, '0');
end $$;

/** เลขที่ใบเบิก: CAPEX = <บริษัท><ปี 2 หลัก>-<ลำดับ 3 หลัก> เช่น PSL26-001, CBS = CBS26-0001 */
create or replace function public._app_doc_no(p_type text, p_company text, p_at timestamptz) returns text
language plpgsql security definer set search_path = public as $$
declare k text := (case when p_type = 'CAPEX' then p_company else 'CBS' end) || to_char(p_at at time zone 'Asia/Bangkok', 'YY');
begin
  return k || '-' || lpad(public._app_next('doc:' || k)::text, case when p_type = 'CAPEX' then 3 else 4 end, '0');
end $$;

create or replace function public._app_item_total(p_item jsonb) returns numeric
language sql immutable set search_path = public as $$
  select round(coalesce((p_item ->> 'amount')::numeric, 0) + coalesce((p_item ->> 'vat')::numeric, 0), 2)
$$;

/** รายการล่างสุด (ไม่มีรายการลูก) — เบิกได้เฉพาะรายการนี้ */
create or replace function public._app_is_leaf(p_items jsonb, p_item jsonb) returns boolean
language sql immutable set search_path = public as $$
  select not exists (
    select 1 from jsonb_array_elements(p_items) x
    where x ->> 'id' <> p_item ->> 'id'
      and left(x ->> 'code', length(p_item ->> 'code') + 1) = (p_item ->> 'code') || '.'
  )
$$;

/** ยอดที่ถูกจอง/ใช้แล้วของรายการ (คำขอ pending + approved) ยกเว้นคำขอ p_exclude */
create or replace function public._app_item_used(p_budget text, p_item text, p_exclude text) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum((ln ->> 'amount')::numeric), 0)
  from public.app_requests rq, jsonb_array_elements(rq.data -> 'lines') ln
  where rq.budget_id = p_budget and rq.status in ('pending', 'approved')
    and (p_exclude is null or rq.id <> p_exclude)
    and ln ->> 'itemId' = p_item
$$;

/** ผลรวมของบรรทัดแบ่งตามรายการ: { itemId: amount } */
create or replace function public._app_sum_by_item(p_lines jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
  from (select ln ->> 'itemId' as k, sum((ln ->> 'amount')::numeric) as v from jsonb_array_elements(p_lines) ln group by 1) s
$$;

-- ---------------------------------------------------------------- session / load

/** ข้อมูลผู้ใช้ปัจจุบัน (ใช้หลัง login เพื่อดูว่ามีบทบาทหรือยัง) */
create or replace function public.app_me() returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(x) from (
    select p.id, p.email, p.name, p.title, p.department, p.role, coalesce(r.name, p.role) as "roleName", p.active,
           case when p.active then coalesce(r.permissions, '{}'::text[]) else '{}'::text[] end as perms
    from public.profiles p left join public.app_roles r on r.key = p.role where p.id = auth.uid()
  ) x
$$;

/** โหลดข้อมูลทั้งหมดที่ผู้ใช้นี้เห็นได้ (ถ้าไม่มีสิทธิ์ดูทั้งหมด เห็นเฉพาะงบและคำขอของตนเอง) */
create or replace function public.app_load() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare u public.profiles; v_all boolean; v_role public.app_roles;
begin
  u := public._app_user();
  if u.id is null then
    raise exception 'ไม่มีสิทธิ์ใช้งาน (ยังไม่ได้รับบทบาท หรือบัญชีถูกปิด)' using errcode = '42501';
  end if;
  select * into v_role from public.app_roles where key = u.role;
  v_all := public._app_view_all(u.role);
  return jsonb_build_object(
    'me', jsonb_build_object('id', u.id, 'name', u.name, 'title', u.title, 'department', u.department, 'role', u.role,
                             'roleName', v_role.name, 'perms', to_jsonb(v_role.permissions)),
    'users', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'title', p.title, 'department', p.department,
                                          'role', p.role, 'roleName', r.name, 'canRequest', 'request.create' = any (r.permissions))
                                        order by p.name)
                       from public.profiles p join public.app_roles r on r.key = p.role where p.active), '[]'::jsonb),
    'pendingUsers', case when 'user.manage' = any (v_role.permissions)
                         then (select count(*) from public.profiles where role is null and active) else null end,
    'master', coalesce((select jsonb_object_agg(m.key, m.data) from public.app_master m), '{}'::jsonb),
    'budgets', coalesce((select jsonb_agg(b.data || jsonb_build_object('id', b.id, 'version', b.version) order by b.created_at)
                         from public.app_budgets b where v_all or b.owner_id = u.id), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(r.data || jsonb_build_object('id', r.id) order by r.created_at)
                          from public.app_requests r where v_all or r.requester_id = u.id), '[]'::jsonb)
  );
end $$;

-- ---------------------------------------------------------------- master data (การเงิน)

create or replace function public.app_save_master(p_key text, p_data jsonb, p_renames jsonb default '[]'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u public.profiles; rn jsonb;
begin
  u := public._app_need('master.manage');
  if p_key not in ('companies', 'departments', 'groups', 'assetTypes', 'glCodes') then
    raise exception 'ไม่รู้จักข้อมูลหลัก %', p_key;
  end if;
  if jsonb_typeof(p_data) <> 'array' then raise exception 'รูปแบบข้อมูลไม่ถูกต้อง'; end if;
  -- เปลี่ยนชื่อหน่วยงาน / ประเภทสินทรัพย์ → แก้ทุกงบที่ใช้อยู่ให้ตรงกัน
  for rn in select * from jsonb_array_elements(coalesce(p_renames, '[]'::jsonb)) loop
    if p_key = 'departments' then
      update public.app_budgets set data = jsonb_set(data, '{department}', to_jsonb(rn ->> 'to')), version = version + 1, updated_at = now()
      where data ->> 'department' = rn ->> 'from';
    elsif p_key = 'assetTypes' then
      update public.app_budgets b set version = version + 1, updated_at = now(),
        data = jsonb_set(b.data, '{items}', (
          select jsonb_agg(case when i ->> 'assetType' = rn ->> 'from' then i || jsonb_build_object('assetType', rn ->> 'to') else i end order by n)
          from jsonb_array_elements(b.data -> 'items') with ordinality as t(i, n)))
      where b.type = 'CAPEX' and exists (select 1 from jsonb_array_elements(b.data -> 'items') i where i ->> 'assetType' = rn ->> 'from');
    end if;
  end loop;
  insert into public.app_master (key, data, updated_at, updated_by) values (p_key, p_data, now(), u.id)
  on conflict (key) do update set data = excluded.data, updated_at = now(), updated_by = u.id;
  return p_data;
end $$;

-- ---------------------------------------------------------------- budgets (การเงิน)

create or replace function public.app_save_budget(p_budget jsonb, p_expected_version integer default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u public.profiles; v_id text; ex public.app_budgets; v_owner uuid; v_data jsonb; v_ver integer;
begin
  u := public._app_need('budget.manage');
  v_id := nullif(p_budget ->> 'id', '');
  if v_id is null then raise exception 'ไม่มีรหัสงบ'; end if;
  if p_budget ->> 'type' not in ('CAPEX', 'CBS') then raise exception 'ประเภทงบไม่ถูกต้อง'; end if;
  if coalesce(trim(p_budget ->> 'code'), '') = '' then raise exception 'กรุณาระบุรหัสงบ'; end if;
  if jsonb_typeof(p_budget -> 'items') <> 'array' then raise exception 'รายการงบไม่ถูกต้อง'; end if;
  v_owner := (p_budget ->> 'ownerId')::uuid;
  if not exists (select 1 from public.profiles where id = v_owner and active and 'request.create' = any (public._app_perms(role))) then
    raise exception 'เจ้าของงบต้องเป็นผู้ใช้ที่ใช้งานอยู่และมีสิทธิ์ขอเบิกใช้งบ';
  end if;
  v_data := (p_budget - 'version') - 'id';
  select * into ex from public.app_budgets where id = v_id for update;
  if found then
    if p_expected_version is not null and ex.version <> p_expected_version then
      raise exception 'มีผู้อื่นแก้ไขงบนี้ไปแล้ว กรุณาโหลดหน้าใหม่แล้วแก้ไขอีกครั้ง' using errcode = '40001';
    end if;
    if ex.type <> p_budget ->> 'type' and exists (select 1 from public.app_requests where budget_id = v_id) then
      raise exception 'งบที่มีการเบิกใช้แล้ว เปลี่ยนประเภทงบไม่ได้';
    end if;
    update public.app_budgets set owner_id = v_owner, type = p_budget ->> 'type', code = trim(p_budget ->> 'code'), data = v_data,
      version = ex.version + 1, updated_at = now() where id = v_id returning version into v_ver;
  else
    insert into public.app_budgets (id, owner_id, type, code, data) values (v_id, v_owner, p_budget ->> 'type', trim(p_budget ->> 'code'), v_data)
    returning version into v_ver;
  end if;
  return v_data || jsonb_build_object('id', v_id, 'version', v_ver);
exception when unique_violation then
  raise exception 'รหัส "%" มีอยู่แล้ว', p_budget ->> 'code';
end $$;

create or replace function public.app_delete_budget(p_id text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._app_need('budget.manage');
  if exists (select 1 from public.app_requests where budget_id = p_id) then
    raise exception 'ลบไม่ได้ — งบนี้มีการขอเบิกแล้ว';
  end if;
  delete from public.app_budgets where id = p_id;
end $$;

-- ---------------------------------------------------------------- requests

/** ตรวจและคำนวณบรรทัดใหม่ฝั่งเซิร์ฟเวอร์ (VAT 7% ตามธง vat ของบรรทัด) */
create or replace function public._app_clean_lines(p_budget public.app_budgets, p_lines jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare l jsonb; it jsonb; out jsonb := '[]'::jsonb; v_before numeric; v_vat numeric; n integer := 0;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'กรุณาใส่รายการที่ขอเบิกอย่างน้อย 1 บรรทัด';
  end if;
  for l in select * from jsonb_array_elements(p_lines) loop
    n := n + 1;
    select x into it from jsonb_array_elements(p_budget.data -> 'items') x where x ->> 'id' = l ->> 'itemId';
    if it is null then raise exception 'บรรทัดที่ %: ไม่พบรายการงบที่เลือก', n; end if;
    if not public._app_is_leaf(p_budget.data -> 'items', it) then raise exception 'บรรทัดที่ %: เบิกได้เฉพาะรายการล่างสุด', n; end if;
    if coalesce(trim(l ->> 'description'), '') = '' then raise exception 'บรรทัดที่ %: กรุณาระบุรายการ', n; end if;
    v_before := round(coalesce((l ->> 'amountBeforeVat')::numeric, 0), 2);
    if v_before <= 0 then raise exception 'บรรทัดที่ %: จำนวนเงินต้องมากกว่า 0', n; end if;
    v_vat := case when coalesce((l ->> 'vat')::numeric, 0) > 0 then round(v_before * 0.07, 2) else 0 end;
    out := out || jsonb_build_object('itemId', l ->> 'itemId', 'description', trim(l ->> 'description'),
                                     'amountBeforeVat', v_before, 'vat', v_vat, 'amount', v_before + v_vat);
  end loop;
  return out;
end $$;

/**
 * สร้างคำขอใหม่ หรือแก้ไขแล้วส่งใหม่ (p_request.id ระบุเมื่อส่งใหม่)
 * CAPEX: เข้าคิวฝ่ายการเงิน · CBS: ออกเอกสารทันที (เกินงบได้แต่ต้องมีเหตุผล)
 */
create or replace function public.app_submit_request(p_request jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u public.profiles; b public.app_budgets; ex public.app_requests; v_now timestamptz := now();
  v_lines jsonb; v_type text; v_id text; v_no text; r jsonb; rec record; it jsonb; v_cap numeric; v_over boolean := false;
  v_before numeric; v_vat numeric; v_amount numeric; v_plan jsonb; v_pct numeric; v_item text;
begin
  u := public._app_need('request.create');
  select * into b from public.app_budgets where id = p_request ->> 'budgetId';
  if not found then raise exception 'ไม่พบงบประมาณ'; end if;
  if b.owner_id <> u.id then raise exception 'คุณไม่ใช่ผู้ขอใช้งบของงบนี้' using errcode = '42501'; end if;
  v_type := b.type;

  if nullif(p_request ->> 'id', '') is not null then
    select * into ex from public.app_requests where id = p_request ->> 'id' for update;
    if not found or ex.requester_id <> u.id or ex.budget_id <> b.id or ex.status <> 'rejected' then
      raise exception 'แก้ไขได้เฉพาะคำขอของตนเองที่ไม่ได้รับอนุมัติเท่านั้น';
    end if;
  end if;

  if coalesce(trim(p_request ->> 'payee'), '') = '' then raise exception 'กรุณาระบุผู้รับเงิน'; end if;
  if coalesce(trim(p_request ->> 'poNo'), '') = '' then raise exception 'กรุณาระบุเลขที่ PO หรือ N/A'; end if;
  v_lines := public._app_clean_lines(b, p_request -> 'lines');
  select sum((x ->> 'amountBeforeVat')::numeric), sum((x ->> 'vat')::numeric), sum((x ->> 'amount')::numeric)
    into v_before, v_vat, v_amount from jsonb_array_elements(v_lines) x;

  if v_type = 'CAPEX' then
    if coalesce(trim(p_request ->> 'purpose'), '') = '' then raise exception 'กรุณาระบุวัตถุประสงค์'; end if;
    if (select count(distinct x ->> 'itemId') from jsonb_array_elements(v_lines) x) <> 1 then
      raise exception 'ใบเบิก CAPEX ใช้ได้กับรายการย่อยเดียว';
    end if;
    v_item := v_lines -> 0 ->> 'itemId';
    select x into it from jsonb_array_elements(b.data -> 'items') x where x ->> 'id' = v_item;
    v_cap := public._app_item_total(it) - public._app_item_used(b.id, v_item, ex.id);
    if v_amount > v_cap + 0.005 then
      raise exception 'จำนวนเงินรวมเกินงบคงเหลือของรายการย่อยนี้ (คงเหลือ % บาท)', to_char(v_cap, 'FM999,999,999,990.00');
    end if;
    v_plan := coalesce(p_request -> 'paymentPlan', '{"mode":"single","installments":[]}'::jsonb);
    if v_plan ->> 'mode' = 'installments' then
      select coalesce(sum((x ->> 'pct')::numeric), 0) into v_pct from jsonb_array_elements(v_plan -> 'installments') x;
      if jsonb_array_length(v_plan -> 'installments') < 2 or round(v_pct, 2) <> 100 then
        raise exception 'แบ่งจ่ายเป็นงวดต้องมีอย่างน้อย 2 งวด และรวมเป็น 100%%';
      end if;
    end if;
  else
    if nullif(p_request ->> 'expenseDate', '') is null then raise exception 'กรุณาระบุวันที่เบิก'; end if;
    -- เกินงบของรายการต้นทุน: อนุญาตแต่ต้องระบุเหตุผล
    for rec in select k as item_id, (v)::numeric as amt from jsonb_each_text(public._app_sum_by_item(v_lines)) as t(k, v) loop
      select x into it from jsonb_array_elements(b.data -> 'items') x where x ->> 'id' = rec.item_id;
      if public._app_item_used(b.id, rec.item_id, ex.id) + rec.amt > public._app_item_total(it) + 0.005 then v_over := true; end if;
    end loop;
    if v_over and coalesce(trim(p_request ->> 'overBudgetReason'), '') = '' then raise exception 'กรุณาระบุเหตุผลที่ใช้เกินงบ'; end if;
  end if;

  v_id := coalesce(ex.id, public._app_rand('r'));
  v_no := coalesce(ex.data ->> 'no', public._app_req_no(v_now));
  r := jsonb_build_object(
    'id', v_id, 'no', v_no, 'budgetId', b.id, 'type', v_type, 'requesterId', u.id,
    'createdAt', coalesce(ex.data ->> 'createdAt', public._app_iso(v_now)),
    'status', 'pending', 'history', coalesce(ex.data -> 'history', '[]'::jsonb),
    'lines', v_lines, 'amountBeforeVat', v_before, 'vat', v_vat, 'amount', v_amount,
    'payee', trim(p_request ->> 'payee'), 'poNo', trim(p_request ->> 'poNo'));
  if ex.id is not null then
    r := r || jsonb_build_object('history', coalesce(ex.data -> 'history', '[]'::jsonb) || coalesce(ex.data -> 'steps', '[]'::jsonb),
                                 'resubmittedAt', public._app_iso(v_now));
  end if;
  if v_type = 'CAPEX' then
    r := r || jsonb_build_object('itemId', v_item, 'purpose', trim(p_request ->> 'purpose'), 'paymentPlan', v_plan,
                                 'paymentTerms', coalesce(p_request ->> 'paymentTerms', ''), 'payments', '[]'::jsonb,
                                 'steps', jsonb_build_array(jsonb_build_object('key', 'fin', 'label', 'ฝ่ายการเงินรับเอกสารและตรวจสอบ', 'role', 'finance', 'status', 'waiting')));
  else
    r := r || jsonb_build_object('expenseDate', p_request ->> 'expenseDate', 'overBudget', v_over,
                                 'overBudgetReason', case when v_over then trim(p_request ->> 'overBudgetReason') else '' end, 'steps', '[]'::jsonb);
    -- CBS ออกเอกสารทันที (GL ตั้งต้นจากรายการต้นทุน บัญชีแก้ไขได้ภายหลัง)
    r := r || jsonb_build_object('status', 'approved', 'approvedAt', public._app_iso(v_now),
                                 'docNo', public._app_doc_no('CBS', b.data ->> 'company', v_now),
                                 'accounting', jsonb_build_object('paymentStatus', 'รอจ่าย'),
                                 'lines', (select jsonb_agg(l || jsonb_build_object(
                                     'glCode', coalesce((select x ->> 'glCode' from jsonb_array_elements(b.data -> 'items') x where x ->> 'id' = l ->> 'itemId'), ''),
                                     'glName', coalesce((select x ->> 'glName' from jsonb_array_elements(b.data -> 'items') x where x ->> 'id' = l ->> 'itemId'), '')) order by n)
                                   from jsonb_array_elements(v_lines) with ordinality as t(l, n)));
  end if;

  if ex.id is null then
    insert into public.app_requests (id, budget_id, requester_id, status, data) values (v_id, b.id, u.id, r ->> 'status', r - 'id');
  else
    update public.app_requests set status = r ->> 'status', data = r - 'id', updated_at = now() where id = v_id;
  end if;
  return r;
end $$;

/** การเงินอนุมัติ / ไม่อนุมัติ เอกสาร CAPEX */
create or replace function public.app_decide_request(p_id text, p_decision text, p_comment text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare u public.profiles; rq public.app_requests; b public.app_budgets; v_now timestamptz := now(); d jsonb; v_over boolean := false; rec record; it jsonb;
begin
  u := public._app_need('request.decide');
  if p_decision not in ('approved', 'rejected') then raise exception 'การตัดสินใจไม่ถูกต้อง'; end if;
  select * into rq from public.app_requests where id = p_id for update;
  if not found then raise exception 'ไม่พบคำขอ'; end if;
  if rq.status <> 'pending' then raise exception 'คำขอนี้ไม่ได้อยู่ระหว่างรอตรวจสอบ'; end if;
  if p_decision = 'rejected' and coalesce(trim(p_comment), '') = '' then raise exception 'กรุณาแจ้งเหตุผลที่ไม่อนุมัติ'; end if;
  select * into b from public.app_budgets where id = rq.budget_id;
  d := rq.data;
  if p_decision = 'approved' then
    -- ตรวจซ้ำว่ายอดรวม (รวมคำขอนี้ที่จองไว้แล้ว) ไม่เกินวงเงินของรายการ
    for rec in select k as item_id, (v)::numeric as amt from jsonb_each_text(public._app_sum_by_item(d -> 'lines')) as t(k, v) loop
      select x into it from jsonb_array_elements(b.data -> 'items') x where x ->> 'id' = rec.item_id;
      if public._app_item_used(b.id, rec.item_id, rq.id) + rec.amt > public._app_item_total(it) + 0.005 then v_over := true; end if;
    end loop;
    if v_over then raise exception 'งบไม่เพียงพอ กรุณาตรวจสอบวงเงินงบอีกครั้ง'; end if;
  end if;
  d := jsonb_set(d, '{steps}', (select jsonb_agg(case when s ->> 'status' = 'waiting'
        then s || jsonb_build_object('status', p_decision, 'by', u.id, 'at', public._app_iso(v_now), 'comment', coalesce(trim(p_comment), ''))
        else s end order by n) from jsonb_array_elements(d -> 'steps') with ordinality as t(s, n)));
  d := d || jsonb_build_object('status', p_decision);
  if p_decision = 'approved' then
    d := d || jsonb_build_object('approvedAt', public._app_iso(v_now), 'docNo', public._app_doc_no(rq.data ->> 'type', b.data ->> 'company', v_now));
  end if;
  update public.app_requests set status = p_decision, data = d, updated_at = now() where id = p_id;
  return d || jsonb_build_object('id', p_id);
end $$;

/** ผู้ขอยกเลิก: คำขอที่ยังรอ/ไม่อนุมัติ (CAPEX) หรือเอกสาร CBS ที่ออกแล้ว (ต้องระบุเหตุผล) */
create or replace function public.app_cancel_request(p_id text, p_reason text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare u public.profiles; rq public.app_requests; d jsonb;
begin
  u := public._app_need('request.create');
  select * into rq from public.app_requests where id = p_id for update;
  if not found or rq.requester_id <> u.id then raise exception 'ไม่พบคำขอ' using errcode = '42501'; end if;
  if not (rq.status in ('pending', 'rejected') or (rq.data ->> 'type' = 'CBS' and rq.status = 'approved')) then
    raise exception 'ยกเลิกเอกสารนี้ไม่ได้';
  end if;
  if rq.status = 'approved' and coalesce(trim(p_reason), '') = '' then raise exception 'กรุณาระบุเหตุผลที่ยกเลิก'; end if;
  d := rq.data || jsonb_build_object('status', 'cancelled', 'cancelledAt', public._app_iso(now()), 'cancelledBy', u.id, 'cancelReason', coalesce(trim(p_reason), ''));
  update public.app_requests set status = 'cancelled', data = d, updated_at = now() where id = p_id;
  return d || jsonb_build_object('id', p_id);
end $$;

-- ---------------------------------------------------------------- payments (CAPEX)

create or replace function public.app_record_payment(p_id text, p_payment jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u public.profiles; rq public.app_requests; d jsonb; v_paid numeric; v_before numeric; v_vat numeric; v_total numeric; v_n integer; pay jsonb;
begin
  u := public._app_need('payment.record');
  select * into rq from public.app_requests where id = p_id for update;
  if not found then raise exception 'ไม่พบคำขอ'; end if;
  if rq.status <> 'approved' or rq.data ->> 'type' <> 'CAPEX' then raise exception 'บันทึกงวดจ่ายได้เฉพาะใบเบิก CAPEX ที่อนุมัติแล้ว'; end if;
  v_before := round(coalesce((p_payment ->> 'amountBeforeVat')::numeric, 0), 2);
  v_vat := round(coalesce((p_payment ->> 'vat')::numeric, 0), 2);
  if v_before <= 0 then raise exception 'จำนวนเงินต้องมากกว่า 0'; end if;
  if v_vat < 0 or v_vat > round(v_before * 0.07, 2) + 0.05 then raise exception 'VAT ไม่ถูกต้อง'; end if;
  if coalesce(p_payment ->> 'dueDate', '') = '' then raise exception 'กรุณาระบุวันที่กำหนดจ่ายเงิน'; end if;
  v_total := v_before + v_vat;
  select coalesce(sum((x ->> 'amount')::numeric), 0), count(*) into v_paid, v_n from jsonb_array_elements(coalesce(rq.data -> 'payments', '[]'::jsonb)) x;
  if v_total > (rq.data ->> 'amount')::numeric - v_paid + 0.005 then
    raise exception 'ยอดงวดนี้ (%) เกินยอดค้างบันทึก % บาท', to_char(v_total, 'FM999,999,999,990.00'), to_char((rq.data ->> 'amount')::numeric - v_paid, 'FM999,999,999,990.00');
  end if;
  pay := jsonb_build_object('id', public._app_rand('p'), 'no', v_n + 1,
    'label', coalesce(nullif(trim(p_payment ->> 'label'), ''), 'งวดที่ ' || (v_n + 1)),
    'deliveryDate', coalesce(p_payment ->> 'deliveryDate', ''), 'dueDate', p_payment ->> 'dueDate',
    'amountBeforeVat', v_before, 'vat', v_vat, 'amount', v_total, 'at', public._app_iso(now()), 'by', u.id);
  d := jsonb_set(rq.data, '{payments}', coalesce(rq.data -> 'payments', '[]'::jsonb) || pay);
  update public.app_requests set data = d, updated_at = now() where id = p_id;
  return d || jsonb_build_object('id', p_id);
end $$;

create or replace function public.app_delete_payment(p_id text, p_pay_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare rq public.app_requests; d jsonb;
begin
  perform public._app_need('payment.record');
  select * into rq from public.app_requests where id = p_id for update;
  if not found then raise exception 'ไม่พบคำขอ'; end if;
  if exists (select 1 from jsonb_array_elements(coalesce(rq.data -> 'payments', '[]'::jsonb)) x
             where x ->> 'id' = p_pay_id and (nullif(x ->> 'acctAt', '') is not null or nullif(x ->> 'paidAt', '') is not null)) then
    raise exception 'ลบไม่ได้ — บัญชีบันทึกข้อมูลของงวดนี้แล้ว';
  end if;
  d := jsonb_set(rq.data, '{payments}', coalesce((select jsonb_agg(x order by n) from jsonb_array_elements(coalesce(rq.data -> 'payments', '[]'::jsonb)) with ordinality as t(x, n)
                                                  where x ->> 'id' <> p_pay_id), '[]'::jsonb));
  update public.app_requests set data = d, updated_at = now() where id = p_id;
  return d || jsonb_build_object('id', p_id);
end $$;

-- ---------------------------------------------------------------- accounting

/**
 * บัญชีบันทึกข้อมูล
 *  CAPEX: p_data = { payments: [{ id, paidAt, asset, expense }] }  (paidAt = วันที่จ่ายจริง → ตัดงบ)
 *  CBS:   p_data = { paymentStatus, paidAt, lines: [{ glCode, glName }] } เรียงตามบรรทัด
 */
create or replace function public.app_accounting_save(p_id text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u public.profiles; rq public.app_requests; d jsonb; v_now text := public._app_iso(now()); pays jsonb := '[]'::jsonb;
  p jsonb; rw jsonb; v_asset numeric; v_exp numeric; v_paid text; v_split boolean; i integer; lines jsonb := '[]'::jsonb; l jsonb; v_status text;
begin
  u := public._app_need('accounting.record');
  select * into rq from public.app_requests where id = p_id for update;
  if not found then raise exception 'ไม่พบคำขอ'; end if;
  if rq.status <> 'approved' then raise exception 'บันทึกข้อมูลบัญชีได้เฉพาะเอกสารที่ออกแล้ว'; end if;
  d := rq.data;
  if d ->> 'type' = 'CAPEX' then
    for p in select * from jsonb_array_elements(coalesce(d -> 'payments', '[]'::jsonb)) loop
      rw := (select x from jsonb_array_elements(coalesce(p_data -> 'payments', '[]'::jsonb)) x where x ->> 'id' = p ->> 'id' limit 1);
      if rw is not null then
        v_paid := nullif(trim(coalesce(rw ->> 'paidAt', '')), '');
        v_split := nullif(coalesce(rw ->> 'asset', ''), '') is not null or nullif(coalesce(rw ->> 'expense', ''), '') is not null;
        if v_split then
          v_asset := round(coalesce(nullif(rw ->> 'asset', '')::numeric, 0), 2);
          v_exp := round(coalesce(nullif(rw ->> 'expense', '')::numeric, 0), 2);
          if v_asset < 0 or v_exp < 0 or v_asset + v_exp > (p ->> 'amount')::numeric + 0.005 then
            raise exception '%: Asset + Expenses เกินยอดงวด', p ->> 'label';
          end if;
          if not (v_asset + v_exp > 0) then raise exception '%: กรุณาระบุมูลค่า Asset และ/หรือ Expenses', p ->> 'label'; end if;
          p := p || jsonb_build_object('asset', v_asset, 'expense', v_exp, 'acctAt', v_now, 'acctBy', u.id);
        end if;
        p := p || jsonb_build_object('paidAt', v_paid, 'paidBy', case when v_paid is null then null else u.id end);
      end if;
      pays := pays || p;
    end loop;
    d := jsonb_set(d, '{payments}', pays);
  else
    v_status := coalesce(p_data ->> 'paymentStatus', 'รอจ่าย');
    if v_status not in ('รอจ่าย', 'จ่ายแล้ว') then raise exception 'สถานะการจ่ายไม่ถูกต้อง'; end if;
    if v_status = 'จ่ายแล้ว' and coalesce(trim(p_data ->> 'paidAt'), '') = '' then raise exception 'กรุณาระบุวันที่จ่ายจริง'; end if;
    i := 0;
    for l in select * from jsonb_array_elements(d -> 'lines') loop
      rw := p_data -> 'lines' -> i;
      lines := lines || (l || jsonb_build_object('glCode', coalesce(trim(rw ->> 'glCode'), l ->> 'glCode', ''),
                                                 'glName', coalesce(trim(rw ->> 'glName'), l ->> 'glName', '')));
      i := i + 1;
    end loop;
    d := jsonb_set(d, '{lines}', lines);
    d := jsonb_set(d, '{accounting}', jsonb_build_object('paymentStatus', v_status,
          'paidAt', case when v_status = 'จ่ายแล้ว' then p_data ->> 'paidAt' else null end, 'updatedAt', v_now, 'updatedBy', u.id));
  end if;
  update public.app_requests set data = d, updated_at = now() where id = p_id;
  return d || jsonb_build_object('id', p_id);
end $$;

-- ---------------------------------------------------------------- user & role management (Admin)

create or replace function public.app_list_users() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._app_need('user.manage');
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'email', p.email, 'name', p.name, 'title', p.title,
                     'department', p.department, 'role', p.role, 'roleName', r.name, 'active', p.active, 'createdAt', public._app_iso(p.created_at))
                   order by p.created_at) from public.profiles p left join public.app_roles r on r.key = p.role), '[]'::jsonb);
end $$;

create or replace function public.app_update_user(p_id uuid, p_name text, p_title text, p_department text, p_role text, p_active boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u public.profiles; target public.profiles; v_role text; v_perms text[]; v_active boolean := coalesce(p_active, true);
begin
  u := public._app_need('user.manage');
  select * into target from public.profiles where id = p_id for update;
  if not found then raise exception 'ไม่พบผู้ใช้'; end if;
  v_role := nullif(trim(coalesce(p_role, '')), '');
  if v_role is not null then
    select permissions into v_perms from public.app_roles where key = v_role;
    if not found then raise exception 'ไม่พบบทบาท %', v_role; end if;
    if coalesce(trim(p_name), '') = '' then raise exception 'กรุณากรอกชื่อ'; end if;
  end if;
  -- ต้องเหลือผู้จัดการผู้ใช้/สิทธิ์ที่ใช้งานอยู่อย่างน้อย 1 คนเสมอ
  if public._app_managers(p_id, null, null) = 0 and not (v_active and v_role is not null and 'user.manage' = any (v_perms)) then
    raise exception 'ต้องมีผู้ดูแลระบบ (ผู้ที่จัดการผู้ใช้และสิทธิ์ได้) ที่ใช้งานอยู่อย่างน้อย 1 คน';
  end if;
  -- เจ้าของงบต้องมีสิทธิ์ขอเบิกใช้งบเสมอ
  if exists (select 1 from public.app_budgets where owner_id = p_id) and not (v_active and v_role is not null and 'request.create' = any (v_perms)) then
    raise exception 'ผู้ใช้นี้เป็นเจ้าของงบอยู่ ย้ายงบให้ผู้อื่นก่อนเปลี่ยนบทบาทหรือปิดการใช้งาน';
  end if;
  update public.profiles set name = trim(coalesce(p_name, '')), title = trim(coalesce(p_title, '')), department = trim(coalesce(p_department, '')),
    role = v_role, active = v_active where id = p_id;
  return (select to_jsonb(x) from (select id, email, name, title, department, role, active from public.profiles where id = p_id) x);
end $$;

create or replace function public.app_list_roles() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._app_need('user.manage');
  return jsonb_build_object(
    'catalog', to_jsonb(public._app_perm_catalog()),
    'roles', coalesce((select jsonb_agg(jsonb_build_object('key', r.key, 'name', r.name, 'description', r.description, 'permissions', to_jsonb(r.permissions),
                         'isSystem', r.is_system, 'users', (select count(*) from public.profiles p where p.role = r.key))
                       order by r.is_system desc, array_position(array['admin', 'finance', 'accounting', 'requester'], r.key), r.created_at, r.key)
                     from public.app_roles r), '[]'::jsonb));
end $$;

/** สร้างหรือแก้บทบาท: p_permissions = ["budget.manage", ...] */
create or replace function public.app_save_role(p_key text, p_name text, p_description text, p_permissions jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u public.profiles; v_perms text[]; v_key text := trim(coalesce(p_key, '')); ex public.app_roles; bad text;
begin
  u := public._app_need('user.manage');
  if v_key !~ '^[a-z][a-z0-9_]{1,29}$' then raise exception 'รหัสบทบาทต้องเป็นตัวอักษรอังกฤษพิมพ์เล็ก ตัวเลข หรือ _ (2-30 ตัว ขึ้นต้นด้วยตัวอักษร)'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'กรุณากรอกชื่อบทบาท'; end if;
  if p_permissions is null or jsonb_typeof(p_permissions) <> 'array' then raise exception 'รูปแบบสิทธิ์ไม่ถูกต้อง'; end if;
  select coalesce(array_agg(distinct x), '{}'::text[]) into v_perms from jsonb_array_elements_text(p_permissions) x;
  select x into bad from unnest(v_perms) x where not (x = any (public._app_perm_catalog())) limit 1;
  if bad is not null then raise exception 'ไม่รู้จักสิทธิ์ %', bad; end if;
  select * into ex from public.app_roles where key = v_key for update;
  if found then
    if public._app_managers(null, v_key, v_perms) = 0 then
      raise exception 'ต้องมีผู้ดูแลระบบ (ผู้ที่จัดการผู้ใช้และสิทธิ์ได้) ที่ใช้งานอยู่อย่างน้อย 1 คน — บทบาทนี้ต้องคงสิทธิ์จัดการผู้ใช้ไว้';
    end if;
    if not ('request.create' = any (v_perms)) and exists (select 1 from public.app_budgets b join public.profiles p on p.id = b.owner_id where p.role = v_key) then
      raise exception 'มีงบที่ผู้ใช้บทบาทนี้เป็นเจ้าของอยู่ ต้องคงสิทธิ์ขอเบิกใช้งบไว้';
    end if;
    update public.app_roles set name = trim(p_name), description = trim(coalesce(p_description, '')), permissions = v_perms where key = v_key;
  else
    insert into public.app_roles (key, name, description, permissions, is_system) values (v_key, trim(p_name), trim(coalesce(p_description, '')), v_perms, false);
  end if;
  return (select jsonb_build_object('key', r.key, 'name', r.name, 'description', r.description, 'permissions', to_jsonb(r.permissions), 'isSystem', r.is_system)
          from public.app_roles r where r.key = v_key);
end $$;

create or replace function public.app_delete_role(p_key text) returns void
language plpgsql security definer set search_path = public as $$
declare ex public.app_roles;
begin
  perform public._app_need('user.manage');
  select * into ex from public.app_roles where key = p_key for update;
  if not found then raise exception 'ไม่พบบทบาท'; end if;
  if ex.is_system then raise exception 'ลบบทบาทตั้งต้นไม่ได้'; end if;
  if exists (select 1 from public.profiles where role = p_key) then raise exception 'ลบไม่ได้ — ยังมีผู้ใช้ที่ใช้บทบาทนี้อยู่'; end if;
  delete from public.app_roles where key = p_key;
end $$;

-- ---------------------------------------------------------------- permissions

-- ถอนสิทธิ์เรียกฟังก์ชันทั้งหมดจากทุกคน แล้วเปิดเฉพาะ app_* ให้ผู้ที่ล็อกอินแล้ว
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.proname like 'app\_%' or p.proname like '\_app\_%' or p.proname = 'handle_new_user')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname like 'app\_%' then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;

-- ให้ PostgREST (API ของ Supabase) รู้จักฟังก์ชันที่เพิ่งสร้าง
notify pgrst, 'reload schema';
