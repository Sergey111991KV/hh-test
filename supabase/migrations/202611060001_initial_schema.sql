-- Mini CRM: auth profiles, objects, tasks, immutable status history and server-side rules.
create extension if not exists pgcrypto;

create type public.app_role as enum ('manager', 'executor');
create type public.task_status as enum ('new', 'in_progress', 'review', 'accepted', 'rework');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role public.app_role not null default 'executor',
  created_at timestamptz not null default now()
);

create table public.objects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  address text not null default '',
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index objects_active_name_address_idx
  on public.objects (name, address)
  where deleted_at is null;

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) between 1 and 160),
  description text not null default '',
  object_id uuid not null references public.objects(id) on delete restrict,
  assignee_id uuid not null references public.profiles(id) on delete restrict,
  status public.task_status not null default 'new',
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index tasks_assignee_status_idx on public.tasks (assignee_id, status);
create index tasks_object_idx on public.tasks (object_id);

create table public.task_history (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete restrict,
  actor_id uuid references auth.users(id) on delete set null,
  actor_name text not null,
  from_status public.task_status,
  to_status public.task_status not null,
  comment text,
  created_at timestamptz not null default now()
);

create index task_history_task_created_idx on public.task_history (task_id, created_at);

create or replace function public.current_app_role()
returns public.app_role
language sql
stable
security definer
set search_path = public, auth
as $$
  select p.role from public.profiles p where p.id = auth.uid()
$$;

create or replace function public.is_manager()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select coalesce(public.current_app_role() = 'manager'::public.app_role, false)
$$;

create or replace function public.can_access_task(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select
    public.is_manager()
    or exists (
      select 1
      from public.tasks t
      join public.objects o on o.id = t.object_id
      where t.id = p_task_id
        and t.assignee_id = auth.uid()
        and t.deleted_at is null
        and o.deleted_at is null
    )
$$;

create or replace function public.add_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1), 'Сотрудник'),
    'executor'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger auth_user_profile_created
after insert on auth.users
for each row execute function public.add_profile_for_new_user();

create or replace function public.log_task_initial_status()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_actor_id uuid := coalesce(auth.uid(), new.created_by);
  v_actor_name text;
begin
  select p.full_name into v_actor_name from public.profiles p where p.id = v_actor_id;
  insert into public.task_history (task_id, actor_id, actor_name, from_status, to_status)
  values (new.id, v_actor_id, coalesce(v_actor_name, 'Система'), null, new.status);
  return new;
end;
$$;

create trigger task_initial_status_history
after insert on public.tasks
for each row execute function public.log_task_initial_status();

create or replace function public.enforce_task_update()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_transition_id text := current_setting('mini_crm.transition_task_id', true);
  v_comment text := nullif(trim(current_setting('mini_crm.transition_comment', true)), '');
  v_manager boolean := public.is_manager();
begin
  if new.status is distinct from old.status then
    if v_transition_id is distinct from new.id::text then
      raise exception 'Change task status through the transition action';
    end if;

    if v_manager then
      if old.status <> 'review' or new.status not in ('accepted', 'rework') then
        raise exception 'Manager cannot make this status transition';
      end if;
    else
      if old.assignee_id <> auth.uid()
        or not (
          (old.status = 'new' and new.status = 'in_progress')
          or (old.status = 'in_progress' and new.status = 'review')
          or (old.status = 'rework' and new.status = 'in_progress')
        )
      then
        raise exception 'Executor cannot make this status transition';
      end if;
    end if;

    if new.status = 'rework' and v_comment is null then
      raise exception 'A comment is required when returning a task for rework';
    end if;

    if new.title is distinct from old.title
      or new.description is distinct from old.description
      or new.object_id is distinct from old.object_id
      or new.assignee_id is distinct from old.assignee_id
      or new.created_by is distinct from old.created_by
      or new.created_at is distinct from old.created_at
      or new.deleted_at is distinct from old.deleted_at
    then
      raise exception 'A status transition cannot edit task details';
    end if;
  elsif not v_manager then
    raise exception 'Only a manager can edit task details';
  end if;

  if new.assignee_id is distinct from old.assignee_id
    and not exists (
      select 1 from public.profiles p
      where p.id = new.assignee_id and p.role = 'executor'
    )
  then
    raise exception 'Task assignee must be an executor';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger task_update_guard
before update on public.tasks
for each row execute function public.enforce_task_update();

create or replace function public.log_task_status_change()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_comment text := nullif(trim(current_setting('mini_crm.transition_comment', true)), '');
begin
  if new.status is distinct from old.status then
    select p.full_name into v_actor_name from public.profiles p where p.id = v_actor_id;
    insert into public.task_history (task_id, actor_id, actor_name, from_status, to_status, comment)
    values (new.id, v_actor_id, coalesce(v_actor_name, 'Система'), old.status, new.status, v_comment);
  end if;
  return new;
end;
$$;

create trigger task_status_history
after update on public.tasks
for each row execute function public.log_task_status_change();

create or replace function public.reject_task_history_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Task history is immutable';
end;
$$;

create trigger task_history_immutable
before update or delete on public.task_history
for each row execute function public.reject_task_history_mutation();

alter table public.profiles enable row level security;
alter table public.objects enable row level security;
alter table public.tasks enable row level security;
alter table public.task_history enable row level security;

create policy profiles_read_self_or_manager
  on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_manager());

create policy objects_read_manager_or_assigned
  on public.objects for select to authenticated
  using (
    public.is_manager()
    or (
      deleted_at is null
      and exists (
        select 1 from public.tasks t
        where t.object_id = objects.id
          and t.assignee_id = auth.uid()
          and t.deleted_at is null
      )
    )
  );

create policy objects_insert_manager
  on public.objects for insert to authenticated
  with check (public.is_manager() and created_by = auth.uid());

create policy objects_update_manager
  on public.objects for update to authenticated
  using (public.is_manager())
  with check (public.is_manager());

create policy tasks_read_manager_or_assignee
  on public.tasks for select to authenticated
  using (public.can_access_task(id));

create policy task_history_read_manager_or_assignee
  on public.task_history for select to authenticated
  using (public.can_access_task(task_id));

revoke all on public.profiles, public.objects, public.tasks, public.task_history from anon, authenticated;
grant usage on type public.app_role, public.task_status to authenticated;
grant select on public.profiles to authenticated;
grant select on public.objects to authenticated;
grant insert (name, address, created_by) on public.objects to authenticated;
grant update (name, address, updated_at) on public.objects to authenticated;
grant select on public.tasks to authenticated;
grant select on public.task_history to authenticated;

create or replace function public.create_task(
  p_title text,
  p_description text,
  p_object_id uuid,
  p_assignee_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_task_id uuid;
begin
  if not public.is_manager() then
    raise exception 'Only a manager can create tasks';
  end if;
  if nullif(trim(p_title), '') is null then
    raise exception 'Task title is required';
  end if;
  if not exists (select 1 from public.objects o where o.id = p_object_id and o.deleted_at is null) then
    raise exception 'Object not found';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_assignee_id and p.role = 'executor') then
    raise exception 'Assignee must be an executor';
  end if;

  insert into public.tasks (title, description, object_id, assignee_id, created_by)
  values (trim(p_title), coalesce(p_description, ''), p_object_id, p_assignee_id, auth.uid())
  returning id into v_task_id;
  return v_task_id;
end;
$$;

create or replace function public.update_task(
  p_task_id uuid,
  p_title text,
  p_description text,
  p_object_id uuid,
  p_assignee_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.is_manager() then
    raise exception 'Only a manager can edit tasks';
  end if;
  if nullif(trim(p_title), '') is null then
    raise exception 'Task title is required';
  end if;
  if not exists (select 1 from public.objects o where o.id = p_object_id and o.deleted_at is null) then
    raise exception 'Object not found';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_assignee_id and p.role = 'executor') then
    raise exception 'Assignee must be an executor';
  end if;

  update public.tasks
  set title = trim(p_title),
      description = coalesce(p_description, ''),
      object_id = p_object_id,
      assignee_id = p_assignee_id
  where id = p_task_id and deleted_at is null;
  if not found then
    raise exception 'Task not found';
  end if;
end;
$$;

create or replace function public.transition_task(
  p_task_id uuid,
  p_to_status public.task_status,
  p_comment text default null
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_task public.tasks%rowtype;
  v_comment text := nullif(trim(p_comment), '');
  v_manager boolean := public.is_manager();
begin
  select * into v_task
  from public.tasks
  where id = p_task_id and deleted_at is null
  for update;
  if not found then
    raise exception 'Task not found';
  end if;

  if v_manager then
    if v_task.status <> 'review' or p_to_status not in ('accepted', 'rework') then
      raise exception 'Manager can only accept or return a task in review';
    end if;
  else
    if v_task.assignee_id <> auth.uid()
      or not (
        (v_task.status = 'new' and p_to_status = 'in_progress')
        or (v_task.status = 'in_progress' and p_to_status = 'review')
        or (v_task.status = 'rework' and p_to_status = 'in_progress')
      )
    then
      raise exception 'Executor cannot make this status transition';
    end if;
  end if;
  if p_to_status = 'rework' and v_comment is null then
    raise exception 'A comment is required when returning a task for rework';
  end if;

  perform set_config('mini_crm.transition_task_id', p_task_id::text, true);
  perform set_config('mini_crm.transition_comment', coalesce(v_comment, ''), true);
  update public.tasks set status = p_to_status where id = p_task_id;
end;
$$;

create or replace function public.soft_delete_task(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.is_manager() then
    raise exception 'Only a manager can delete tasks';
  end if;
  update public.tasks set deleted_at = now()
  where id = p_task_id and deleted_at is null;
  if not found then
    raise exception 'Task not found';
  end if;
end;
$$;

create or replace function public.soft_delete_object(p_object_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.is_manager() then
    raise exception 'Only a manager can delete objects';
  end if;
  update public.objects set deleted_at = now(), updated_at = now()
  where id = p_object_id and deleted_at is null;
  if not found then
    raise exception 'Object not found';
  end if;
end;
$$;

revoke all on function public.current_app_role() from public, anon;
revoke all on function public.is_manager() from public, anon;
revoke all on function public.can_access_task(uuid) from public, anon;
revoke all on function public.add_profile_for_new_user() from public, anon, authenticated;
revoke all on function public.log_task_initial_status() from public, anon, authenticated;
revoke all on function public.enforce_task_update() from public, anon, authenticated;
revoke all on function public.log_task_status_change() from public, anon, authenticated;
revoke all on function public.reject_task_history_mutation() from public, anon, authenticated;
revoke all on function public.create_task(text, text, uuid, uuid) from public, anon;
revoke all on function public.update_task(uuid, text, text, uuid, uuid) from public, anon;
revoke all on function public.transition_task(uuid, public.task_status, text) from public, anon;
revoke all on function public.soft_delete_task(uuid) from public, anon;
revoke all on function public.soft_delete_object(uuid) from public, anon;

grant execute on function public.current_app_role() to authenticated;
grant execute on function public.is_manager() to authenticated;
grant execute on function public.can_access_task(uuid) to authenticated;
grant execute on function public.create_task(text, text, uuid, uuid) to authenticated;
grant execute on function public.update_task(uuid, text, text, uuid, uuid) to authenticated;
grant execute on function public.transition_task(uuid, public.task_status, text) to authenticated;
grant execute on function public.soft_delete_task(uuid) to authenticated;
grant execute on function public.soft_delete_object(uuid) to authenticated;
