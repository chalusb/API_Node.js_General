import type { Category } from '@/types/categories';

type CategoriesCache = {
  data: Category[];
  updatedAt: number;
};

let cache: CategoriesCache | null = null;
const DEFAULT_TTL_MS = 60_000;

export const setCategoriesCache = (data: Category[]) => {
  cache = {
    data: JSON.parse(JSON.stringify(data)),
    updatedAt: Date.now(),
  };
};

export const getCategoriesCache = () => cache;

export const isCategoriesCacheFresh = (ttlMs: number = DEFAULT_TTL_MS) => {
  if (!cache) return false;
  return Date.now() - cache.updatedAt < ttlMs;
};

export const clearCategoriesCache = () => {
  cache = null;
};
