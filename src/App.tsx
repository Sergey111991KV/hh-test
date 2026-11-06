import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { getErrorMessage, isSupabaseConfigured, supabase } from './lib/supabase'
import { STATUS_LABELS, STATUS_ORDER, type AppRole, type Profile, type SiteObject, type TaskHistoryEntry, type TaskStatus, type WorkTask } from './lib/types'

type Screen = 'overview' | 'objects' | 'tasks' | 'my-tasks' | 'site-detail'
type FormModal = { kind: 'object'; objectId?: string } | { kind: 'task'; taskId?: string; objectId?: string }
type ToastState = { message: string; tone: 'success' | 'error' } | null

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [profileError, setProfileError] = useState('')
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [objects, setObjects] = useState<SiteObject[]>([])
  const [tasks, setTasks] = useState<WorkTask[]>([])
  const [people, setPeople] = useState<Profile[]>([])
  const [screen, setScreen] = useState<Screen>('overview')
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [formModal, setFormModal] = useState<FormModal | null>(null)
  const [search, setSearch] = useState('')
  const [toast, setToast] = useState<ToastState>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!supabase) {
      setAuthLoading(false)
      return
    }
    let active = true
    void supabase.auth.getSession().then(({ data }) => {
      if (active) {
        setSession(data.session)
        setAuthLoading(false)
      }
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setAuthLoading(false)
    })
    return () => {
      active = false
      listener.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!supabase || !session) {
      setProfile(null)
      setWorkspaceLoading(false)
      return
    }
    let active = true
    setWorkspaceLoading(true)
    setProfile(null)
    setProfileError('')
    void supabase.from('profiles').select('id, full_name, role').eq('id', session.user.id).maybeSingle().then(({ data, error }) => {
      if (!active) return
      if (error) {
        setProfileError(getErrorMessage(error))
        setProfile(null)
      } else if (!data) {
        setProfileError('Для этой учётной записи ещё не настроен профиль. Попросите руководителя добавить вас в систему.')
        setProfile(null)
      } else {
        setProfileError('')
        setProfile(data as Profile)
      }
      setWorkspaceLoading(false)
    })
    return () => { active = false }
  }, [session?.user.id])

  const loadWorkspace = useCallback(async () => {
    if (!supabase || !profile) return
    setWorkspaceLoading(true)
    const [objectResult, taskResult, peopleResult] = await Promise.all([
      supabase.from('objects').select('*').order('created_at', { ascending: false }),
      supabase.from('tasks').select('*').order('created_at', { ascending: false }),
      profile.role === 'manager'
        ? supabase.from('profiles').select('id, full_name, role').eq('role', 'executor').order('full_name')
        : Promise.resolve({ data: [profile], error: null }),
    ])
    const error = objectResult.error || taskResult.error || peopleResult.error
    if (error) {
      setToast({ message: getErrorMessage(error), tone: 'error' })
    } else {
      setObjects((objectResult.data ?? []) as SiteObject[])
      setTasks((taskResult.data ?? []) as WorkTask[])
      setPeople((peopleResult.data ?? []) as Profile[])
    }
    setWorkspaceLoading(false)
  }, [profile])

  useEffect(() => {
    if (profile) void loadWorkspace()
  }, [profile, loadWorkspace])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const activeObjects = useMemo(() => objects.filter((item) => !item.deleted_at), [objects])
  const objectById = useMemo(() => new Map(objects.map((item) => [item.id, item] as const)), [objects])
  const personById = useMemo(() => new Map(people.map((item) => [item.id, item] as const)), [people])
  const visibleTasks = useMemo(() => tasks.filter((task) => !task.deleted_at && !objectById.get(task.object_id)?.deleted_at), [tasks, objectById])
  const selectedObject = selectedObjectId ? objectById.get(selectedObjectId) : undefined
  const selectedTask = selectedTaskId ? tasks.find((task) => task.id === selectedTaskId) : undefined

  async function runAction(action: () => Promise<{ error: unknown }>, successMessage: string): Promise<boolean> {
    if (!supabase) return false
    setBusy(true)
    try {
      const { error } = await action()
      if (error) {
        setToast({ message: getErrorMessage(error), tone: 'error' })
        return false
      }
      setToast({ message: successMessage, tone: 'success' })
      setFormModal(null)
      setSelectedTaskId(null)
      await loadWorkspace()
      return true
    } catch (error) {
      setToast({ message: getErrorMessage(error), tone: 'error' })
      return false
    } finally {
      setBusy(false)
    }
  }

  async function saveObject(event: FormEvent<HTMLFormElement>, existing?: SiteObject) {
    event.preventDefault()
    if (!supabase || !profile) return
    const fields = new FormData(event.currentTarget)
    const name = String(fields.get('name') ?? '').trim()
    const address = String(fields.get('address') ?? '').trim()
    if (existing) {
      await runAction(() => supabase.from('objects').update({ name, address, updated_at: new Date().toISOString() }).eq('id', existing.id), 'Объект сохранён')
    } else {
      await runAction(() => supabase.from('objects').insert({ name, address, created_by: profile.id }), 'Объект добавлен')
    }
  }

  async function saveTask(event: FormEvent<HTMLFormElement>, existing?: WorkTask) {
    event.preventDefault()
    if (!supabase) return
    const fields = new FormData(event.currentTarget)
    const values = {
      p_title: String(fields.get('title') ?? '').trim(),
      p_description: String(fields.get('description') ?? '').trim(),
      p_object_id: String(fields.get('object_id') ?? ''),
      p_assignee_id: String(fields.get('assignee_id') ?? ''),
    }
    await runAction(() => existing
      ? supabase.rpc('update_task', { p_task_id: existing.id, ...values })
      : supabase.rpc('create_task', values), existing ? 'Задача обновлена' : 'Задача создана')
  }

  async function transitionTask(status: TaskStatus, comment = '') {
    if (!supabase || !selectedTask) return
    await runAction(() => supabase.rpc('transition_task', { p_task_id: selectedTask.id, p_to_status: status, p_comment: comment }), status === 'accepted' ? 'Задача принята' : status === 'rework' ? 'Задача возвращена на доработку' : 'Статус обновлён')
  }

  async function deleteObject(object: SiteObject) {
    if (!supabase || !window.confirm('Убрать объект «' + object.name + '» из активного списка? История задач сохранится.')) return
    const deleted = await runAction(() => supabase.rpc('soft_delete_object', { p_object_id: object.id }), 'Объект удалён из активного списка')
    if (deleted) {
      setScreen('objects')
      setSelectedObjectId(null)
    }
  }

  async function deleteTask(task: WorkTask) {
    if (!supabase || !window.confirm('Убрать задачу «' + task.title + '» из активного списка? История сохранится.')) return
    await runAction(() => supabase.rpc('soft_delete_task', { p_task_id: task.id }), 'Задача удалена из активного списка')
  }

  async function signOut() {
    if (!supabase) return
    const { error } = await supabase.auth.signOut()
    if (error) setToast({ message: getErrorMessage(error), tone: 'error' })
    setScreen('overview')
    setSelectedObjectId(null)
  }

  if (!isSupabaseConfigured) return <SetupScreen />
  if (authLoading) return <FullScreenLoader label="Подключаемся к рабочему пространству" />
  if (!session) return <LoginScreen />
  if (workspaceLoading && !profile) return <FullScreenLoader label="Загружаем профиль" />
  if (!profile) return <ProfileMissingScreen message={profileError} onSignOut={signOut} />

  const navScreen: Screen = screen === 'site-detail' ? 'objects' : screen
  const pageTitle = selectedObject && screen === 'site-detail' ? selectedObject.name
    : screen === 'objects' ? 'Объекты'
      : screen === 'tasks' || screen === 'my-tasks' ? (profile.role === 'manager' ? 'Все задачи' : 'Мои задачи')
        : 'Обзор'

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><span /></span><span className="brand-name">контур<span>.</span></span></div>
        <div className="workspace-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <nav className="primary-nav" aria-label="Основная навигация">
          <NavButton active={navScreen === 'overview'} onClick={() => setScreen('overview')} symbol="◫" label={profile.role === 'manager' ? 'Обзор' : 'Моя работа'} />
          <NavButton active={navScreen === 'objects'} onClick={() => setScreen('objects')} symbol="▤" label="Объекты" />
          <NavButton active={navScreen === (profile.role === 'manager' ? 'tasks' : 'my-tasks')} onClick={() => setScreen(profile.role === 'manager' ? 'tasks' : 'my-tasks')} symbol="☷" label={profile.role === 'manager' ? 'Все задачи' : 'Мои задачи'} count={visibleTasks.length} />
        </nav>
        {profile.role === 'manager' && <div className="sidebar-note"><span className="note-icon">✳</span><div><strong>Всё под контролем</strong><p>Задачи и история изменений доступны в одном месте.</p></div></div>}
        <div className="sidebar-bottom"><div className="user-row"><Avatar name={profile.full_name} /><div className="user-copy"><strong>{profile.full_name}</strong><span>{profile.role === 'manager' ? 'Руководитель' : 'Исполнитель'}</span></div><button className="icon-button signout" onClick={signOut} title="Выйти" aria-label="Выйти">↗</button></div></div>
      </aside>
      <main className="main-area">
        <header className="topbar"><div className="breadcrumbs"><span>Рабочее пространство</span><b>/</b><strong>{pageTitle}</strong></div><div className="topbar-right"><span className="today-label">{todayLabel()}</span><span className="top-avatar"><Avatar name={profile.full_name} /></span></div></header>
        <div className="content-wrap">
          {workspaceLoading && <div className="refresh-line"><span /> Обновляем данные…</div>}
          {screen === 'overview' && profile.role === 'manager' && <Overview profile={profile} objects={activeObjects} tasks={visibleTasks} personById={personById} onOpenObject={(id) => { setSelectedObjectId(id); setScreen('site-detail') }} onViewObjects={() => setScreen('objects')} onOpenTask={setSelectedTaskId} onCreateObject={() => setFormModal({ kind: 'object' })} onCreateTask={() => setFormModal({ kind: 'task' })} />}
          {screen === 'overview' && profile.role === 'executor' && <ExecutorHome profile={profile} tasks={visibleTasks} objects={objectById} onOpenTask={setSelectedTaskId} onGoToTasks={() => setScreen('my-tasks')} />}
          {screen === 'objects' && <ObjectsPage objects={activeObjects} tasks={visibleTasks} query={search} role={profile.role} onQuery={setSearch} onOpen={(id) => { setSelectedObjectId(id); setScreen('site-detail') }} onCreate={() => setFormModal({ kind: 'object' })} onEdit={(id) => setFormModal({ kind: 'object', objectId: id })} onDelete={(item) => void deleteObject(item)} />}
          {screen === 'site-detail' && selectedObject && <ObjectDetail object={selectedObject} tasks={visibleTasks.filter((task) => task.object_id === selectedObject.id)} people={personById} role={profile.role} onBack={() => setScreen('objects')} onOpenTask={setSelectedTaskId} onCreateTask={() => setFormModal({ kind: 'task', objectId: selectedObject.id })} onEditObject={() => setFormModal({ kind: 'object', objectId: selectedObject.id })} onDeleteObject={() => void deleteObject(selectedObject)} />}
          {(screen === 'tasks' || screen === 'my-tasks') && <TasksPage role={profile.role} tasks={visibleTasks.filter((task) => profile.role === 'manager' || task.assignee_id === profile.id)} objects={objectById} people={personById} query={search} onQuery={setSearch} onOpenTask={setSelectedTaskId} onCreateTask={() => setFormModal({ kind: 'task' })} />}
        </div>
      </main>
      {formModal && <FormDialog modal={formModal} objects={activeObjects} people={people} existingObject={formModal.kind === 'object' && formModal.objectId ? objectById.get(formModal.objectId) : undefined} existingTask={formModal.kind === 'task' && formModal.taskId ? tasks.find((task) => task.id === formModal.taskId) : undefined} busy={busy} onClose={() => setFormModal(null)} onSaveObject={(event, item) => void saveObject(event, item)} onSaveTask={(event, item) => void saveTask(event, item)} />}
      {selectedTask && <TaskDialog task={selectedTask} object={objectById.get(selectedTask.object_id)} assignee={personById.get(selectedTask.assignee_id)} role={profile.role} busy={busy} onClose={() => setSelectedTaskId(null)} onTransition={(status, comment) => void transitionTask(status, comment)} onEdit={() => setFormModal({ kind: 'task', taskId: selectedTask.id })} onDelete={() => void deleteTask(selectedTask)} />}
      {toast && <Toast toast={toast} onDismiss={() => setToast(null)} />}
    </div>
  )
}

function SetupScreen() {
  return <div className="setup-screen"><div className="setup-card"><Brand /><div className="setup-icon">⌁</div><p className="eyebrow">ПОСЛЕДНИЙ ШАГ ПЕРЕД ЗАПУСКОМ</p><h1>Подключите рабочее пространство</h1><p className="muted">Для входа и хранения задач нужна база Supabase. Адрес и публичный ключ проекта добавляются в локальный файл окружения.</p><ol className="setup-steps"><li><span>1</span><div><strong>Создайте проект Supabase</strong><small>Бесплатного тарифа хватит для демонстрации.</small></div></li><li><span>2</span><div><strong>Примените миграцию и демо-данные</strong><small>Обе команды описаны в README.</small></div></li><li><span>3</span><div><strong>Заполните .env.local</strong><small>Используйте .env.example как образец.</small></div></li></ol><div className="setup-footnote">Регистрация выключена. Учётные записи создаются руководителем в Supabase.</div></div></div>
}

function FullScreenLoader({ label }: { label: string }) {
  return <div className="loading-screen"><div className="loader-ring" /><span>{label}</span></div>
}

function LoginScreen() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return
    setLoading(true)
    setError('')
    const { error: loginError } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (loginError) setError('Не получилось войти. Проверьте почту и пароль.')
    setLoading(false)
  }
  return (
    <div className="login-screen">
      <div className="login-aside"><Brand light /><div className="login-illustration" aria-hidden="true"><div className="illustration-sun" /><div className="illustration-building building-one"><i /><i /><i /><i /></div><div className="illustration-building building-two"><i /><i /><i /></div><div className="illustration-ground" /><div className="illustration-card"><span className="mini-check">✓</span><div><b>Объект готов</b><small>ЖК «Сосновый берег»</small></div></div></div><div className="login-aside-copy"><span>ПОРЯДОК В КАЖДОМ ПРОЕКТЕ</span><h2>Стройка движется,<br />когда всё на месте.</h2><p>Объекты, задачи и история работы — в одном простом пространстве.</p></div><div className="login-aside-footer">КОНТУР · УПРАВЛЕНИЕ СТРОИТЕЛЬСТВОМ</div></div>
      <div className="login-panel"><div className="login-panel-inner"><div className="mobile-brand"><Brand /></div><div className="login-tag"><span className="tag-dot" /> ВАШЕ РАБОЧЕЕ ПРОСТРАНСТВО</div><h1>С возвращением</h1><p className="login-description">Войдите, чтобы продолжить работу с объектами и задачами.</p><form className="login-form" onSubmit={(event) => void submit(event)}><label htmlFor="login-email">Электронная почта</label><div className="input-wrap"><span className="input-symbol">✉</span><input id="login-email" type="email" autoComplete="email" placeholder="name@company.ru" value={email} onChange={(event) => setEmail(event.target.value)} required /></div><div className="password-label"><label htmlFor="login-password">Пароль</label><span>Только для приглашённых</span></div><div className="input-wrap"><span className="input-symbol">⌑</span><input id="login-password" type="password" autoComplete="current-password" placeholder="Введите пароль" value={password} onChange={(event) => setPassword(event.target.value)} required /></div>{error && <div className="form-error" role="alert">{error}</div>}<button className="button button-primary login-submit" type="submit" disabled={loading}>{loading ? 'Входим…' : 'Войти в пространство'}<span>→</span></button></form><div className="login-help"><span>Нужен доступ?</span><span>Свяжитесь с руководителем</span></div><div className="login-security"><span>◈</span><p>Доступ к рабочей информации зависит от вашей роли.</p></div></div><div className="login-copyright">© 2026 Контур · Простая координация больших дел</div></div>
    </div>
  )
}

function ProfileMissingScreen({ message, onSignOut }: { message: string; onSignOut: () => void }) {
  return <div className="profile-missing"><div className="missing-card"><div className="setup-icon">?</div><p className="eyebrow">УЧЁТНАЯ ЗАПИСЬ</p><h1>Профиль не настроен</h1><p className="muted">{message}</p><button className="button button-secondary" onClick={onSignOut}>Выйти из системы</button></div></div>
}

function Brand({ light = false }: { light?: boolean }) {
  return <div className={'brand' + (light ? ' brand-light' : '')}><span className="brand-mark"><span /></span><span className="brand-name">контур<span>.</span></span></div>
}

function NavButton({ active, onClick, symbol, label, count }: { active: boolean; onClick: () => void; symbol: string; label: string; count?: number }) {
  return <button className={'nav-item' + (active ? ' active' : '')} onClick={onClick} aria-label={label} title={label}><span className="nav-symbol">{symbol}</span><span>{label}</span>{count !== undefined && <span className="nav-count">{count}</span>}</button>
}

function Avatar({ name, size = 'normal' }: { name: string; size?: 'normal' | 'small' }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toLocaleUpperCase('ru-RU') || '?'
  return <span className={'avatar avatar-' + size} aria-hidden="true">{initials}</span>
}

function StatusPill({ status }: { status: TaskStatus }) {
  const marks: Record<TaskStatus, string> = { new: '○', in_progress: '◒', review: '◷', accepted: '✓', rework: '↻' }
  return <span className={'status-pill status-' + status}><i>{marks[status]}</i>{STATUS_LABELS[status]}</span>
}

function Overview({ profile, objects, tasks, personById, onOpenObject, onViewObjects, onOpenTask, onCreateObject, onCreateTask }: {
  profile: Profile; objects: SiteObject[]; tasks: WorkTask[]; personById: Map<string, Profile>
  onOpenObject: (id: string) => void; onViewObjects: () => void; onOpenTask: (id: string) => void; onCreateObject: () => void; onCreateTask: () => void
}) {
  const active = tasks.filter((task) => ['new', 'in_progress', 'rework'].includes(task.status)).length
  const reviews = tasks.filter((task) => task.status === 'review')
  const accepted = tasks.filter((task) => task.status === 'accepted').length
  return <div className="page-stack">
    <div className="welcome-row"><div><p className="eyebrow">{todayLabel(true)}</p><h1>Добрый день, {profile.full_name.split(' ')[0]} <span className="wave">✳</span></h1><p className="muted">Вот что происходит на объектах сегодня.</p></div><div className="welcome-actions"><button className="button button-secondary" onClick={onCreateObject}>＋ Новый объект</button><button className="button button-primary" onClick={onCreateTask}>＋ Поставить задачу</button></div></div>
    <section className="stats-grid"><StatCard label="Активные объекты" value={objects.length} detail="Все строительные площадки" symbol="▤" tone="green" /><StatCard label="Задачи в работе" value={active} detail="У исполнителей сейчас" symbol="◷" tone="blue" /><StatCard label="Ждут проверки" value={reviews.length} detail={reviews.length ? 'Нужен ваш ответ' : 'Всё проверено'} symbol="◎" tone="orange" /><StatCard label="Принято" value={accepted} detail="Задачи завершены" symbol="✓" tone="purple" /></section>
    <div className="dashboard-grid"><section className="panel objects-panel"><div className="panel-heading"><div><p className="eyebrow">ВАШИ ПЛОЩАДКИ</p><h2>Объекты</h2></div><button className="text-button" onClick={onViewObjects}>Все объекты <span>→</span></button></div>{objects.length ? <div className="object-cards">{objects.slice(0, 4).map((object, index) => <ObjectCard key={object.id} object={object} tasks={tasks.filter((task) => task.object_id === object.id)} index={index} onOpen={() => onOpenObject(object.id)} />)}</div> : <EmptyState title="Пока нет объектов" description="Добавьте первую строительную площадку." action={<button className="button button-primary" onClick={onCreateObject}>＋ Добавить объект</button>} />}</section>
      <section className="panel review-panel"><div className="panel-heading"><div><p className="eyebrow">ОТ ВАШЕЙ КОМАНДЫ</p><h2>На проверке <span className="heading-count">{reviews.length}</span></h2></div><span className="live-dot">СЕЙЧАС</span></div>{reviews.length ? <div className="review-list">{reviews.slice(0, 5).map((task) => <TaskRow key={task.id} task={task} object={objects.find((item) => item.id === task.object_id)} assignee={personById.get(task.assignee_id)} onClick={() => onOpenTask(task.id)} />)}</div> : <EmptyState title="Ничего не ждёт проверки" description="Когда исполнитель отправит задачу, она появится здесь." />}</section></div>
    <div className="tip-banner"><div className="tip-icon">✳</div><div><strong>Понятно каждому участнику</strong><p>В карточке задачи собраны описание, исполнитель, текущий статус и вся история изменений.</p></div><span className="tip-arrow">↗</span></div>
  </div>
}

function StatCard({ label, value, detail, symbol, tone }: { label: string; value: number; detail: string; symbol: string; tone: string }) {
  return <article className="stat-card"><div className={'stat-symbol ' + tone}>{symbol}</div><span className="stat-label">{label}</span><div className="stat-bottom"><strong>{value.toString().padStart(2, '0')}</strong><span>{detail}</span></div></article>
}

function ObjectCard({ object, tasks, index, onOpen }: { object: SiteObject; tasks: WorkTask[]; index: number; onOpen: () => void }) {
  const open = tasks.filter((task) => task.status !== 'accepted').length
  const covers = ['cover-sage', 'cover-sand', 'cover-sky', 'cover-clay']
  const initials = object.name.split(/[\s«»]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toLocaleUpperCase('ru-RU')
  return <button className="object-card" onClick={onOpen}><div className={'object-cover ' + covers[index % covers.length]}><div className="cover-lines"><span /><span /><span /></div><span className="object-monogram">{initials}</span><span className="cover-badge"><i /> В РАБОТЕ</span></div><div className="object-card-body"><div className="object-title-row"><h3>{object.name}</h3><span className="arrow-circle">↗</span></div><p className="object-address">⌖ {object.address || 'Адрес не указан'}</p><div className="object-meta"><span><b>{tasks.length}</b> задач</span><span className="meta-divider" /><span className="open-task-count"><i />{open} активных</span></div></div></button>
}

function TaskRow({ task, object, assignee, onClick }: { task: WorkTask; object?: SiteObject; assignee?: Profile; onClick: () => void }) {
  const mark = task.status === 'accepted' ? '✓' : task.status === 'review' ? '◷' : '•'
  return <button className="task-row" onClick={onClick}><span className={'task-row-mark mark-' + task.status}>{mark}</span><span className="task-row-copy"><strong>{task.title}</strong><small>{object?.name ?? 'Объект'} <span>·</span> {assignee?.full_name ?? 'Исполнитель'}</small></span><StatusPill status={task.status} /><span className="task-row-arrow">→</span></button>
}

function ExecutorHome({ profile, tasks, objects, onOpenTask, onGoToTasks }: { profile: Profile; tasks: WorkTask[]; objects: Map<string, SiteObject>; onOpenTask: (id: string) => void; onGoToTasks: () => void }) {
  const mine = tasks.filter((task) => task.assignee_id === profile.id)
  const activeMine = mine.filter((task) => task.status !== 'accepted')
  const due = mine.filter((task) => task.status === 'review')
  return <div className="page-stack"><div className="welcome-row executor-welcome"><div><p className="eyebrow">ВАША РАБОЧАЯ ЗОНА</p><h1>Здравствуйте, {profile.full_name.split(' ')[0]} <span className="wave">✳</span></h1><p className="muted">Здесь только ваши задачи и связанные с ними объекты.</p></div><div className="welcome-actions"><button className="button button-primary" onClick={onGoToTasks}>Открыть мои задачи <span>→</span></button></div></div>
    <section className="executor-summary"><div className="executor-summary-icon">☷</div><div><span className="eyebrow">СЕЙЧАС У ВАС</span><strong>{activeMine.length} {pluralize(activeMine.length, 'активная задача', 'активные задачи', 'активных задач')}</strong></div><div className="summary-divider" /><div><span className="summary-review-dot" /><span>{due.length} на проверке</span></div></section>
    <section className="panel my-work-panel"><div className="panel-heading"><div><p className="eyebrow">ВАШ СПИСОК</p><h2>Мои задачи</h2></div><button className="text-button" onClick={onGoToTasks}>Все задачи <span>→</span></button></div>{mine.length ? <div className="review-list">{mine.slice(0, 6).map((task) => <TaskRow key={task.id} task={task} object={objects.get(task.object_id)} onClick={() => onOpenTask(task.id)} />)}</div> : <EmptyState title="Задач пока нет" description="Руководитель назначит вам задачу, когда она будет готова." />}</section>
    <div className="executor-note"><span>i</span><p>Переходите к следующему шагу прямо в карточке задачи. История изменений поможет понять, что уже сделано.</p></div></div>
}

function ObjectsPage({ objects, tasks, query, role, onQuery, onOpen, onCreate, onEdit, onDelete }: { objects: SiteObject[]; tasks: WorkTask[]; query: string; role: AppRole; onQuery: (value: string) => void; onOpen: (id: string) => void; onCreate: () => void; onEdit: (id: string) => void; onDelete: (object: SiteObject) => void }) {
  const filtered = objects.filter((item) => (item.name + ' ' + item.address).toLocaleLowerCase('ru-RU').includes(query.toLocaleLowerCase('ru-RU')))
  return <div className="page-stack"><div className="page-heading-row"><div><p className="eyebrow">{objects.length} АКТИВНЫХ ПЛОЩАДОК</p><h1>Объекты</h1><p className="muted">{role === 'manager' ? 'Стройки и связанные с ними задачи.' : 'Объекты, где у вас есть назначенные задачи.'}</p></div>{role === 'manager' && <button className="button button-primary" onClick={onCreate}>＋ Новый объект</button>}</div><div className="toolbar"><SearchBox value={query} onChange={onQuery} placeholder="Найти объект…" /><span className="toolbar-note">Показано {filtered.length} из {objects.length}</span></div>{filtered.length ? <div className="object-grid">{filtered.map((object, index) => <div className="object-grid-item" key={object.id}><ObjectCard object={object} tasks={tasks.filter((task) => task.object_id === object.id)} index={index} onOpen={() => onOpen(object.id)} />{role === 'manager' && <div className="object-grid-actions"><button onClick={() => onEdit(object.id)}>Изменить</button><button onClick={() => onDelete(object)}>Удалить</button></div>}</div>)}</div> : <EmptyState title={query ? 'Совпадений нет' : 'Объектов пока нет'} description={query ? 'Попробуйте изменить запрос.' : 'Добавьте первую строительную площадку.'} action={role === 'manager' && !query ? <button className="button button-primary" onClick={onCreate}>＋ Добавить объект</button> : undefined} />}</div>
}

function ObjectDetail({ object, tasks, people, role, onBack, onOpenTask, onCreateTask, onEditObject, onDeleteObject }: { object: SiteObject; tasks: WorkTask[]; people: Map<string, Profile>; role: AppRole; onBack: () => void; onOpenTask: (id: string) => void; onCreateTask: () => void; onEditObject: () => void; onDeleteObject: () => void }) {
  return <div className="page-stack"><button className="back-link" onClick={onBack}>← <span>Все объекты</span></button><div className="object-detail-hero"><div className="detail-cover"><div className="cover-lines"><span /><span /><span /></div><span className="detail-cover-caption">ОБЪЕКТ · КОНТУР</span><span className="cover-index">№ {object.id.slice(0, 4).toUpperCase()}</span></div><div className="detail-title-row"><div><p className="eyebrow">СТРОИТЕЛЬНАЯ ПЛОЩАДКА</p><h1>{object.name}</h1><p className="muted">⌖ {object.address || 'Адрес не указан'}</p></div>{role === 'manager' && <div className="welcome-actions"><button className="button button-secondary" onClick={onEditObject}>Изменить объект</button><button className="button button-quiet-danger" onClick={onDeleteObject}>Удалить</button></div>}</div></div><div className="section-title-row"><div><p className="eyebrow">РАБОЧИЙ ПЛАН</p><h2>Задачи объекта <span className="heading-count">{tasks.length}</span></h2></div>{role === 'manager' && <button className="button button-primary" onClick={onCreateTask}>＋ Поставить задачу</button>}</div>{tasks.length ? <div className="panel task-table">{tasks.map((task) => <TaskRow key={task.id} task={task} object={object} assignee={people.get(task.assignee_id)} onClick={() => onOpenTask(task.id)} />)}</div> : <EmptyState title="Задач пока нет" description="Создайте первую задачу для этой площадки." action={role === 'manager' ? <button className="button button-primary" onClick={onCreateTask}>＋ Поставить задачу</button> : undefined} />}</div>
}

function TasksPage({ role, tasks, objects, people, query, onQuery, onOpenTask, onCreateTask }: { role: AppRole; tasks: WorkTask[]; objects: Map<string, SiteObject>; people: Map<string, Profile>; query: string; onQuery: (value: string) => void; onOpenTask: (id: string) => void; onCreateTask: () => void }) {
  const [statusFilter, setStatusFilter] = useState<TaskStatus | 'all'>('all')
  const filtered = tasks.filter((task) => {
    const haystack = task.title + ' ' + task.description + ' ' + (objects.get(task.object_id)?.name ?? '')
    return haystack.toLocaleLowerCase('ru-RU').includes(query.toLocaleLowerCase('ru-RU')) && (statusFilter === 'all' || task.status === statusFilter)
  })
  return <div className="page-stack"><div className="page-heading-row"><div><p className="eyebrow">{tasks.length} {pluralize(tasks.length, 'ЗАДАЧА', 'ЗАДАЧИ', 'ЗАДАЧ')}</p><h1>{role === 'manager' ? 'Все задачи' : 'Мои задачи'}</h1><p className="muted">{role === 'manager' ? 'Контролируйте ход работ на всех объектах.' : 'Ваши назначенные задачи и следующие действия.'}</p></div>{role === 'manager' && <button className="button button-primary" onClick={onCreateTask}>＋ Поставить задачу</button>}</div><div className="task-filters"><SearchBox value={query} onChange={onQuery} placeholder="Найти задачу…" /><div className="filter-chips"><FilterChip active={statusFilter === 'all'} onClick={() => setStatusFilter('all')}>Все <b>{tasks.length}</b></FilterChip>{STATUS_ORDER.map((status) => <FilterChip key={status} active={statusFilter === status} onClick={() => setStatusFilter(status)}>{STATUS_LABELS[status]}</FilterChip>)}</div></div>{filtered.length ? <div className="panel task-table">{filtered.map((task) => <TaskRow key={task.id} task={task} object={objects.get(task.object_id)} assignee={people.get(task.assignee_id)} onClick={() => onOpenTask(task.id)} />)}</div> : <EmptyState title={query || statusFilter !== 'all' ? 'Задач не найдено' : 'Задач пока нет'} description={query || statusFilter !== 'all' ? 'Измените фильтр или поисковый запрос.' : 'Назначенные задачи появятся здесь.'} />}</div>
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label className="search-box"><span>⌕</span><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button className={'filter-chip' + (active ? ' selected' : '')} onClick={onClick}>{children}</button>
}

function FormDialog({ modal, objects, people, existingObject, existingTask, busy, onClose, onSaveObject, onSaveTask }: { modal: FormModal; objects: SiteObject[]; people: Profile[]; existingObject?: SiteObject; existingTask?: WorkTask; busy: boolean; onClose: () => void; onSaveObject: (event: FormEvent<HTMLFormElement>, existing?: SiteObject) => void; onSaveTask: (event: FormEvent<HTMLFormElement>, existing?: WorkTask) => void }) {
  const isObject = modal.kind === 'object'
  const initialObjectId = existingTask?.object_id ?? (modal.kind === 'task' ? modal.objectId ?? '' : '')
  return <DialogShell title={isObject ? (existingObject ? 'Изменить объект' : 'Новый объект') : (existingTask ? 'Изменить задачу' : 'Новая задача')} subtitle={isObject ? 'Основные сведения о строительной площадке.' : 'Опишите результат, выберите объект и исполнителя.'} onClose={onClose}>
    {isObject ? <form className="dialog-form" onSubmit={(event) => onSaveObject(event, existingObject)}><Field label="Название объекта"><input name="name" defaultValue={existingObject?.name ?? ''} placeholder="Например, ЖК «Сосновый берег»" maxLength={120} required autoFocus /></Field><Field label="Адрес"><input name="address" defaultValue={existingObject?.address ?? ''} placeholder="Город, улица, участок" /></Field><div className="dialog-footer"><button className="button button-secondary" type="button" onClick={onClose}>Отмена</button><button className="button button-primary" disabled={busy}>{busy ? 'Сохраняем…' : existingObject ? 'Сохранить изменения' : 'Добавить объект'}</button></div></form>
      : <form className="dialog-form" onSubmit={(event) => onSaveTask(event, existingTask)}><Field label="Название задачи"><input name="title" defaultValue={existingTask?.title ?? ''} placeholder="Например, проверить гидроизоляцию" maxLength={160} required autoFocus /></Field><Field label="Что нужно сделать"><textarea name="description" defaultValue={existingTask?.description ?? ''} placeholder="Опишите ожидаемый результат и важные детали" rows={4} /></Field><div className="form-two-columns"><Field label="Объект"><select name="object_id" defaultValue={initialObjectId} required><option value="" disabled>Выберите объект</option>{objects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="Исполнитель"><select name="assignee_id" defaultValue={existingTask?.assignee_id ?? ''} required><option value="" disabled>Выберите сотрудника</option>{people.map((item) => <option key={item.id} value={item.id}>{item.full_name}</option>)}</select></Field></div><div className="form-info"><span>↳</span> Новая задача появится у выбранного исполнителя.</div><div className="dialog-footer"><button className="button button-secondary" type="button" onClick={onClose}>Отмена</button><button className="button button-primary" disabled={busy}>{busy ? 'Сохраняем…' : existingTask ? 'Сохранить изменения' : 'Создать задачу'}</button></div></form>}
  </DialogShell>
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>
}

function DialogShell({ title, subtitle, children, onClose }: { title: string; subtitle: string; children: ReactNode; onClose: () => void }) {
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="dialog-card" role="dialog" aria-modal="true" aria-label={title}><div className="dialog-heading"><div><p className="eyebrow">КОНТУР · РАБОЧЕЕ ПРОСТРАНСТВО</p><h2>{title}</h2><p className="muted">{subtitle}</p></div><button className="icon-button dialog-close" onClick={onClose} aria-label="Закрыть">×</button></div>{children}</section></div>
}

function TaskDialog({ task, object, assignee, role, busy, onClose, onTransition, onEdit, onDelete }: { task: WorkTask; object?: SiteObject; assignee?: Profile; role: AppRole; busy: boolean; onClose: () => void; onTransition: (status: TaskStatus, comment?: string) => void; onEdit: () => void; onDelete: () => void }) {
  const [history, setHistory] = useState<TaskHistoryEntry[]>([])
  const [historyError, setHistoryError] = useState('')
  const [comment, setComment] = useState('')
  const [returning, setReturning] = useState(false)
  useEffect(() => {
    if (!supabase) return
    let active = true
    void supabase.from('task_history').select('*').eq('task_id', task.id).order('created_at', { ascending: true }).then(({ data, error }) => {
      if (!active) return
      if (error) setHistoryError(getErrorMessage(error))
      else setHistory((data ?? []) as TaskHistoryEntry[])
    })
    return () => { active = false }
  }, [task.id])
  const executorAction = role === 'executor' && task.status === 'new' ? { status: 'in_progress' as const, label: 'Взять в работу' }
    : role === 'executor' && task.status === 'in_progress' ? { status: 'review' as const, label: 'Отправить на проверку' }
      : role === 'executor' && task.status === 'rework' ? { status: 'in_progress' as const, label: 'Начать доработку' } : null
  return <div className="dialog-backdrop task-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="task-dialog" role="dialog" aria-modal="true" aria-label={'Задача: ' + task.title}>
    <div className="task-dialog-top"><button className="back-link" onClick={onClose}>← <span>К списку задач</span></button><div className="task-dialog-actions">{role === 'manager' && <><button className="button button-secondary button-small" onClick={onEdit}>Изменить</button><button className="icon-button" onClick={onDelete} aria-label="Удалить задачу">⌫</button></>}<button className="icon-button dialog-close" onClick={onClose} aria-label="Закрыть">×</button></div></div>
    <div className="task-dialog-content"><div className="task-dialog-main"><div className="task-kicker"><span className="task-kicker-mark">☷</span> ЗАДАЧА <span>·</span> {object?.name ?? 'Объект'}</div><h1>{task.title}</h1><div className="task-status-line"><StatusPill status={task.status} /><span className="created-inline">Создана {formatDate(task.created_at)}</span></div><div className="task-description-block"><p className="eyebrow">ЧТО НУЖНО СДЕЛАТЬ</p><p>{task.description || 'Подробности не добавлены.'}</p></div>
      {role === 'manager' && task.status === 'review' && <div className="manager-review-box"><div className="review-box-title"><span className="review-box-icon">◷</span><div><strong>Задача ждёт проверки</strong><small>Выберите, что делать дальше.</small></div></div>{returning && <Field label="Комментарий для исполнителя (обязателен)"><textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Что нужно исправить или проверить повторно?" rows={3} autoFocus /></Field>}<div className="review-actions"><button className="button button-success" disabled={busy} onClick={() => onTransition('accepted')}>✓ Принять задачу</button>{returning ? <button className="button button-warning" disabled={busy || !comment.trim()} onClick={() => onTransition('rework', comment.trim())}>Вернуть на доработку</button> : <button className="button button-secondary" onClick={() => setReturning(true)}>↶ На доработку</button>}</div></div>}
      {executorAction && <div className="executor-action-box"><div><strong>{executorAction.label}</strong><small>{executorAction.status === 'review' ? 'После отправки руководитель проверит результат.' : 'Статус обновится для вас и руководителя.'}</small></div><button className="button button-primary" disabled={busy} onClick={() => onTransition(executorAction.status)}>{busy ? 'Обновляем…' : executorAction.label}<span>→</span></button></div>}
      <div className="history-section"><div className="history-heading"><div><p className="eyebrow">ХРОНОЛОГИЯ РАБОТ</p><h2>История задачи</h2></div><span className="history-count">{history.length} {pluralize(history.length, 'запись', 'записи', 'записей')}</span></div>{historyError ? <p className="muted">{historyError}</p> : history.length ? <div className="timeline">{history.map((entry) => <div className="timeline-entry" key={entry.id}><span className="timeline-point" /><div className="timeline-body"><div className="timeline-title"><strong>{entry.actor_name}</strong><span>{formatDateTime(entry.created_at)}</span></div><p>{entry.from_status ? STATUS_LABELS[entry.from_status] + ' → ' : 'Создала задачу со статусом → '}<b>{STATUS_LABELS[entry.to_status]}</b></p>{entry.comment && <blockquote>{entry.comment}</blockquote>}</div></div>)}</div> : <p className="muted">История пока пуста.</p>}</div>
    </div><aside className="task-side-panel"><div className="side-panel-block"><span className="eyebrow">ОТВЕТСТВЕННЫЙ</span><div className="assignee-card"><Avatar name={assignee?.full_name ?? 'Исполнитель'} /><div><strong>{assignee?.full_name ?? 'Исполнитель'}</strong><span>Исполнитель</span></div></div></div><div className="side-panel-block"><span className="eyebrow">ОБЪЕКТ</span><div className="related-object"><span className="related-icon">▤</span><div><strong>{object?.name ?? 'Объект'}</strong><span>{object?.address || 'Адрес не указан'}</span></div></div></div><div className="side-panel-block"><span className="eyebrow">СОЗДАНА</span><p className="side-date">◷ &nbsp;{formatDateTime(task.created_at)}</p></div><div className="privacy-note"><span>◈</span><p>Каждое действие сохраняется в истории задачи.</p></div></aside></div>
  </section></div>
}

function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-illustration"><span>◫</span><i>✳</i></div><h3>{title}</h3><p>{description}</p>{action}</div>
}

function Toast({ toast, onDismiss }: { toast: Exclude<ToastState, null>; onDismiss: () => void }) {
  return <div className={'toast toast-' + toast.tone} role="status"><span>{toast.tone === 'success' ? '✓' : '!'}</span><p>{toast.message}</p><button onClick={onDismiss} aria-label="Закрыть">×</button></div>
}

function todayLabel(uppercase = false) {
  const label = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())
  return uppercase ? label.toLocaleUpperCase('ru-RU') : label
}

function pluralize(value: number, one: string, few: string, many: string) {
  const tens = value % 100
  const ones = value % 10
  if (tens > 10 && tens < 20) return many
  if (ones > 1 && ones < 5) return few
  if (ones === 1) return one
  return many
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(value))
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

export default App
