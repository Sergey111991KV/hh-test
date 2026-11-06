-- Run after creating the three confirmed Auth users listed in README.md.
-- Safe to rerun: the active object names and demo task titles are checked first.
do $$
declare
  v_manager uuid;
  v_executor_one uuid;
  v_executor_two uuid;
  v_object_one uuid;
  v_object_two uuid;
  v_object_three uuid;
begin
  select id into v_manager from auth.users where email = 'manager@example.com';
  select id into v_executor_one from auth.users where email = 'executor1@example.com';
  select id into v_executor_two from auth.users where email = 'executor2@example.com';
  if v_manager is null or v_executor_one is null or v_executor_two is null then
    raise exception 'Create the three test users from README.md in Supabase Auth first.';
  end if;

  update public.profiles set full_name = 'Анна Смирнова', role = 'manager' where id = v_manager;
  update public.profiles set full_name = 'Илья Петров', role = 'executor' where id = v_executor_one;
  update public.profiles set full_name = 'Мария Волкова', role = 'executor' where id = v_executor_two;

  select id into v_object_one from public.objects where name = 'ЖК «Сосновый берег»' and deleted_at is null;
  if v_object_one is null then
    insert into public.objects (name, address, created_by) values ('ЖК «Сосновый берег»', 'Москва, ул. Лесная, 18', v_manager) returning id into v_object_one;
  end if;
  select id into v_object_two from public.objects where name = 'Квартал на Речной' and deleted_at is null;
  if v_object_two is null then
    insert into public.objects (name, address, created_by) values ('Квартал на Речной', 'Москва, наб. Долгорукова, 7', v_manager) returning id into v_object_two;
  end if;
  select id into v_object_three from public.objects where name = 'Малоэтажный парк Север' and deleted_at is null;
  if v_object_three is null then
    insert into public.objects (name, address, created_by) values ('Малоэтажный парк Север', 'Химки, Сосновый проезд, 4', v_manager) returning id into v_object_three;
  end if;

  insert into public.tasks (title, description, object_id, assignee_id, status, created_by)
  select 'Проверить гидроизоляцию паркинга', 'Проверить швы и примыкания на -1 этаже. Приложить фото замечаний.', v_object_one, v_executor_one, 'review', v_manager
  where not exists (select 1 from public.tasks where title = 'Проверить гидроизоляцию паркинга' and object_id = v_object_one and deleted_at is null);
  insert into public.tasks (title, description, object_id, assignee_id, status, created_by)
  select 'Сверить объём бетона на секции Б', 'Сопоставить фактическую заливку с журналом работ.', v_object_one, v_executor_two, 'in_progress', v_manager
  where not exists (select 1 from public.tasks where title = 'Сверить объём бетона на секции Б' and object_id = v_object_one and deleted_at is null);
  insert into public.tasks (title, description, object_id, assignee_id, status, created_by)
  select 'Проверить ведомость арматуры', 'Сверить диаметры и количество с рабочими чертежами.', v_object_one, v_executor_one, 'new', v_manager
  where not exists (select 1 from public.tasks where title = 'Проверить ведомость арматуры' and object_id = v_object_one and deleted_at is null);
  insert into public.tasks (title, description, object_id, assignee_id, status, created_by)
  select 'Доработать схему временного освещения', 'Добавить отметки высот и проверить длину кабельных линий.', v_object_two, v_executor_two, 'rework', v_manager
  where not exists (select 1 from public.tasks where title = 'Доработать схему временного освещения' and object_id = v_object_two and deleted_at is null);
  insert into public.tasks (title, description, object_id, assignee_id, status, created_by)
  select 'Установить защитные ограждения', 'Проверить ограждение у въезда и лестничного марша.', v_object_two, v_executor_one, 'accepted', v_manager
  where not exists (select 1 from public.tasks where title = 'Установить защитные ограждения' and object_id = v_object_two and deleted_at is null);
  insert into public.tasks (title, description, object_id, assignee_id, status, created_by)
  select 'Проверить геометрию фундамента', 'Снять диагонали и отметить фактические отклонения.', v_object_three, v_executor_two, 'in_progress', v_manager
  where not exists (select 1 from public.tasks where title = 'Проверить геометрию фундамента' and object_id = v_object_three and deleted_at is null);
end;
$$;
