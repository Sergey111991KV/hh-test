export type AppRole = 'manager' | 'executor'

export type TaskStatus = 'new' | 'in_progress' | 'review' | 'accepted' | 'rework'

export interface Profile {
  id: string
  full_name: string
  role: AppRole
}

export interface SiteObject {
  id: string
  name: string
  address: string
  created_by: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface WorkTask {
  id: string
  title: string
  description: string
  object_id: string
  assignee_id: string
  status: TaskStatus
  created_by: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface TaskHistoryEntry {
  id: string
  task_id: string
  actor_id: string | null
  actor_name: string
  from_status: TaskStatus | null
  to_status: TaskStatus
  comment: string | null
  created_at: string
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  new: 'Новая',
  in_progress: 'В работе',
  review: 'На проверке',
  accepted: 'Принята',
  rework: 'На доработке',
}

export const STATUS_ORDER: TaskStatus[] = ['new', 'in_progress', 'review', 'rework', 'accepted']
