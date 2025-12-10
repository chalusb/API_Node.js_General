export type TaskStatus = 'pendiente' | 'en_progreso' | 'detenida' | 'completada' | string;

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  dueDate?: string | null;
  createdAt?: string;
  updatedAt?: string;
  order?: number | null;
}

export interface Category {
  id: string;
  title: string;
  description?: string;
  color?: string | null;
  createdAt?: string;
  updatedAt?: string;
  tasks: Task[];
  tasksCount: number;
}
