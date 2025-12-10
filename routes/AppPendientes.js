"use strict";
const fs = require('fs');
const express = require('express');
const goo = require('./../core/google/googleDrive');
const utils = require('./../core/utils');
const { g_files } = require('./../keys');
const router = express.Router();
const pushNotificationsRouter = require('./pushNotifications');
const deliverNotification =
  typeof pushNotificationsRouter.deliverNotification === 'function'
    ? pushNotificationsRouter.deliverNotification
    : null;
router.use('/notifications', pushNotificationsRouter);
const { PDFDocument, rgb, StandardFonts, degrees, TextAlignment } = require('pdf-lib');
const QRCode = require('qrcode');
const { json } = require('body-parser');

// Firestore (optional new backend)
let db;
let admin;
let _fsInitErr;
try {
  ({ db, admin } = require('../core/firebase'));
} catch (e) {
  _fsInitErr = e;
  console.error('Firestore init error:', e.message);
  // If Firebase env is not configured yet, routes below will return 503
}

// Firestore configuration (collection and default doc names)
const FS_COLLECTION = process.env.FS_COLLECTION || 'PendientesGenerales';
const FS_DOC = process.env.FS_DOC || 'Pendientes';
const FS_TASKS_SUBCOL = process.env.FS_TASKS_SUBCOL || 'tareas';
const DEFAULT_TASK_STATUSES = ['pendiente', 'en_progreso', 'detenida', 'completada'];
const TASK_STATUS_ENV = (process.env.FS_TASK_STATUSES || '')
  .split(',')
  .map((status) => status.trim().toLowerCase())
  .filter(Boolean);
const TASK_STATUSES = TASK_STATUS_ENV.length ? TASK_STATUS_ENV : DEFAULT_TASK_STATUSES;
const TASK_STATUS_SET = new Set(TASK_STATUSES);
const DEFAULT_TASK_STATUS = TASK_STATUSES[0] || 'pendiente';
const SUPERMARKET_COLLECTION = process.env.FS_SUPERMARKET_COLLECTION || 'SuperMarket';
const SUPERMARKET_DEFAULTS = Object.freeze({
  quantity: 1,
  unit: 'pz',
  priority: 2,
  checked: false,
  recurring: 'none',
  tags: [],
});
const SUPERMARKET_PRIORITY_VALUES = new Set([1, 2, 3]);
const SUPERMARKET_RECURRING_VALUES = new Set(['none', 'weekly', 'biweekly', 'monthly']);
const NOTES_COLLECTION = process.env.FS_NOTES_COLLECTION || 'Notes';
const NOTE_TYPES = new Set(['normal', 'manzana']);
const DEFAULT_NOTE_TYPE = 'normal';
const CALENDAR_COLLECTION = process.env.FS_CALENDAR_COLLECTION || 'CalendarEvents';
const CALENDAR_COLLECTION_FALLBACKS = (process.env.FS_CALENDAR_COLLECTION_FALLBACKS || '')
  .split(',')
  .map(item => item && item.trim())
  .filter(Boolean);
const CALENDAR_COLLECTION_CANDIDATES = Array.from(
  new Set([
    CALENDAR_COLLECTION,
    ...CALENDAR_COLLECTION_FALLBACKS,
    'Calendar',
    'Calendario',
    'CalendarEvents',
  ]),
).filter(Boolean);
const DEBTS_COLLECTION = process.env.FS_DEBTS_COLLECTION || 'Debts';
const DEBTS_COLLECTION_FALLBACKS = (process.env.FS_DEBTS_COLLECTION_FALLBACKS || '')
  .split(',')
  .map(item => item && item.trim())
  .filter(Boolean);
const DEBTS_COLLECTION_CANDIDATES = Array.from(
  new Set([DEBTS_COLLECTION, ...DEBTS_COLLECTION_FALLBACKS, 'Debts', 'DebtLedger', 'Loans']),
).filter(Boolean);
const DEBT_ALLOWED_TYPES = new Set(['deuda', 'abono']);
const NOTIFICATION_SOUND = 'notifications.wav';

const truncateText = (value, maxLength = 120) => {
  if (value === undefined || value === null) return '';
  const text = String(value).trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  const sliceLength = Math.max(1, maxLength - 3);
  return `${text.slice(0, sliceLength).trimEnd()}...`;
};

const notifyEntityCreated = async ({ title, body, data }) => {
  if (!deliverNotification) {
    return;
  }
  try {
    await deliverNotification({
      title: title || 'Nuevo registro',
      body: body || '',
      data: data || {},
      sound: NOTIFICATION_SOUND,
    });
  } catch (error) {
    console.error('[NOTIFICATIONS] broadcast entity error', error);
  }
};

const notifyEntityUpdated = async ({ title, body, data }) => {
  const payloadData = data && typeof data === 'object' ? { ...data } : {};
  if (!Object.prototype.hasOwnProperty.call(payloadData, 'action')) {
    payloadData.action = 'updated';
  }
  await notifyEntityCreated({
    title: title || 'Registro actualizado',
    body: body || '',
    data: payloadData,
  });
};

function getDb() {
  if (db) return db;
  try {
    ({ db, admin } = require('../core/firebase'));
    _fsInitErr = undefined;
    return db;
  } catch (e) {
    _fsInitErr = e;
    return undefined;
  }
}

function ensureDb(res) {
  const database = getDb();
  if (!database) {
    res.status(503).json({ status: 'error', message: 'Firestore no configurado' });
    return null;
  }
  return database;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeTaskStatus(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_TASK_STATUS;
  const normalized = String(value).trim().toLowerCase();
  return TASK_STATUS_SET.has(normalized) ? normalized : null;
}

function normalizeDebtType(value) {
  if (value === undefined || value === null) {
    return 'deuda';
  }
  const normalized = String(value).trim().toLowerCase();
  if (DEBT_ALLOWED_TYPES.has(normalized)) {
    return normalized;
  }
  if (normalized === 'pago' || normalized === 'payment') {
    return 'abono';
  }
  if (normalized === 'loan' || normalized === 'prestamo') {
    return 'deuda';
  }
  return 'deuda';
}

function normalizeDebtAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return NaN;
}

function normalizeDebtDate(value) {
  if (!value) {
    return nowIso();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return nowIso();
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed.toISOString();
    }
  }
  return nowIso();
}

function toIsoDateOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed.toISOString();
    }
  }
  if (value && typeof value.toDate === 'function') {
    try {
      return value.toDate().toISOString();
    } catch (error) {
      return null;
    }
  }
  return null;
}

function parseOrderSpec(value, allowedFields, defaultField = 'date', defaultDirection = 'desc') {
  if (!value || typeof value !== 'string') {
    return { field: defaultField, direction: defaultDirection };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { field: defaultField, direction: defaultDirection };
  }
  let direction = 'asc';
  let field = trimmed;
  if (trimmed.startsWith('-')) {
    direction = 'desc';
    field = trimmed.slice(1);
  } else if (trimmed.startsWith('+')) {
    field = trimmed.slice(1);
  }
  if (!allowedFields.has(field)) {
    field = defaultField;
  }
  return { field, direction };
}

function sortDebtEntries(items) {
  return items.sort((a, b) => {
    if (a.date && b.date && a.date !== b.date) {
      return b.date.localeCompare(a.date);
    }
    if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) {
      return b.createdAt.localeCompare(a.createdAt);
    }
    return b.updatedAt && a.updatedAt ? b.updatedAt.localeCompare(a.updatedAt) : 0;
  });
}

async function safeGet(query, orderField, direction = 'asc') {
  try {
    return await query.orderBy(orderField, direction).get();
  } catch (error) {
    const code = error.code || error.codeNumber;
    const isPrecondition = code === 9 || code === 'failed-precondition';
    if (isPrecondition) {
      return await query.get();
    }
    throw error;
  }
}

function parseOrderValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}

function getComparableTimestamp(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value.toDate === 'function') {
    try {
      return value.toDate().toISOString();
    } catch (error) {
      return '';
    }
  }
  return '';
}

async function loadAndRepairTaskDocs(categoryRef) {
  const tasksRef = categoryRef.collection(FS_TASKS_SUBCOL);
  const snap = await tasksRef.get();
  if (snap.empty) return [];

  const items = snap.docs.map(doc => {
    const data = doc.data();
    return {
      doc,
      order: parseOrderValue(data.order),
      createdAt: getComparableTimestamp(data.createdAt),
    };
  });

  let highestOrder = -1;
  items.forEach(item => {
    if (item.order !== null && item.order > highestOrder) {
      highestOrder = item.order;
    }
  });

  const unordered = items.filter(item => item.order === null);
  if (unordered.length) {
    unordered.sort((a, b) => {
      if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) {
        return a.createdAt.localeCompare(b.createdAt);
      }
      return a.doc.id.localeCompare(b.doc.id);
    });

    const batch = categoryRef.firestore.batch();
    let nextOrder = highestOrder;
    const now = nowIso();
    unordered.forEach(item => {
      nextOrder += 1;
      item.order = nextOrder;
      batch.update(item.doc.ref, { order: item.order, updatedAt: now });
    });

    await batch.commit();
  }

  return items
    .sort((a, b) => {
      if (a.order !== null && b.order !== null && a.order !== b.order) {
        return a.order - b.order;
      }
      if (a.order !== null) return -1;
      if (b.order !== null) return 1;
      if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) {
        return a.createdAt.localeCompare(b.createdAt);
      }
      return a.doc.id.localeCompare(b.doc.id);
    })
    .map(item => item.doc);
}
async function getTasksSnapshot(categoryRef) {
  const tasksQuery = categoryRef.collection(FS_TASKS_SUBCOL);
  try {
    const snap = await safeGet(tasksQuery, 'order');
    const totalCount = await getTaskCount(categoryRef);
    const hasInvalidOrders = snap.docs.some(doc => parseOrderValue(doc.get('order')) === null);
    if (snap.size === totalCount && !hasInvalidOrders) {
      return { docs: snap.docs, size: snap.size, empty: snap.empty };
    }
    // Fall back to rebuilding the order locally when Firestore cannot sort by order
  } catch (error) {
    console.warn('[PENDIENTES] getTasksSnapshot order fallback', error);
  }

  const docs = await loadAndRepairTaskDocs(categoryRef);
  return { docs, size: docs.length, empty: docs.length === 0 };
}

async function loadCategoriesSnapshot(database) {
  const collectionRef = database.collection(FS_COLLECTION);
  try {
    const snap = await safeGet(collectionRef, 'order');
    const hasInvalidOrders = snap.docs.some(doc => parseOrderValue(doc.get('order')) === null);
    if (!snap.empty && !hasInvalidOrders) {
      return { docs: snap.docs, size: snap.size, empty: snap.empty };
    }
    // If ordering by `order` fails, we will repair locally below
  } catch (error) {
    console.warn('[PENDIENTES] loadCategoriesSnapshot order fallback', error);
  }

  const snap = await collectionRef.get();
  if (snap.empty) {
    return { docs: [], size: 0, empty: true };
  }

  const items = snap.docs.map(doc => {
    const data = doc.data();
    return {
      doc,
      order: parseOrderValue(data.order),
      createdAt: getComparableTimestamp(data.createdAt),
    };
  });

  let highestOrder = -1;
  items.forEach(item => {
    if (item.order !== null && item.order > highestOrder) {
      highestOrder = item.order;
    }
  });

  const unordered = items.filter(item => item.order === null);
  if (unordered.length) {
    unordered.sort((a, b) => {
      if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) {
        return a.createdAt.localeCompare(b.createdAt);
      }
      return a.doc.id.localeCompare(b.doc.id);
    });

    const batch = database.batch();
    let nextOrder = highestOrder;
    const now = nowIso();
    unordered.forEach(item => {
      nextOrder += 1;
      item.order = nextOrder;
      batch.update(item.doc.ref, { order: item.order, updatedAt: now });
    });

    await batch.commit();
  }

  const sortedDocs = items
    .sort((a, b) => {
      if (a.order !== null && b.order !== null && a.order !== b.order) {
        return a.order - b.order;
      }
      if (a.order !== null) return -1;
      if (b.order !== null) return 1;
      if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) {
        return a.createdAt.localeCompare(b.createdAt);
      }
      return a.doc.id.localeCompare(b.doc.id);
    })
    .map(item => item.doc);

  return { docs: sortedDocs, size: sortedDocs.length, empty: sortedDocs.length === 0 };
}

async function getTaskCount(categoryRef) {
  const tasksRef = categoryRef.collection(FS_TASKS_SUBCOL);
  if (typeof tasksRef.count === 'function') {
    try {
      const agg = await tasksRef.count().get();
      return agg.data().count || 0;
    } catch (error) {
      const code = error.code || error.codeNumber;
      const isUnimplemented = code === 12 || code === 'unimplemented';
      if (!isUnimplemented) {
        throw error;
      }
      console.warn('[PENDIENTES] getTaskCount fallback to list()', error);
    }
  }
  const snap = await tasksRef.get();
  return snap.size;
}

function mapCategoryData(doc) {
  const data = doc.data();
  const category = { id: doc.id, ...data };
  if (!category.title && typeof category.name === 'string') category.title = category.name;
  if (!category.title && typeof category.Nombre === 'string') category.title = category.Nombre;
  if (!category.description && typeof category.descripcion === 'string') category.description = category.descripcion;
  const orderValue = parseOrderValue(data.order);
  if (orderValue !== null) {
    category.order = orderValue;
  }
  return category;
}

function mapTaskData(doc) {
  const data = doc.data();
  return { id: doc.id, ...data };
}

function toTrimmedString(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  return '';
}

function toNullableString(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = toTrimmedString(value);
  return trimmed || null;
}

function parseCheckedValue(value) {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'si', 'si', 'checked'].includes(normalized)) return true;
    if (['false', '0', 'no', 'unchecked'].includes(normalized)) return false;
  }
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  return null;
}

function sanitizeTagsValue(value) {
  if (value === undefined) return undefined;
  if (value === null) return [];
  let source;
  if (Array.isArray(value)) {
    source = value;
  } else if (typeof value === 'string') {
    source = value.split(',');
  } else {
    return null;
  }
  const tags = Array.from(new Set(source.map(item => toTrimmedString(item)).filter(Boolean)));
  return tags;
}

function sanitizeSupermarketPayload(payload, { partial = false } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: 'El cuerpo debe ser un objeto' };
  }

  const sanitized = {};
  const errors = [];
  const has = key => Object.prototype.hasOwnProperty.call(payload, key);

  const hasName = has('name');
  if (!partial || hasName) {
    const name = toTrimmedString(payload.name);
    if (!name) {
      errors.push('name');
    } else {
      sanitized.name = name;
    }
  }

  const hasQuantity = has('quantity');
  if (hasQuantity) {
    const quantity = Number(payload.quantity);
    if (!Number.isFinite(quantity) || quantity < 0) {
      errors.push('quantity');
    } else {
      sanitized.quantity = Math.round(quantity * 100) / 100;
    }
  } else if (!partial) {
    sanitized.quantity = SUPERMARKET_DEFAULTS.quantity;
  }

  const hasUnit = has('unit');
  if (hasUnit) {
    const unit = toTrimmedString(payload.unit);
    if (!unit) {
      errors.push('unit');
    } else {
      sanitized.unit = unit;
    }
  } else if (!partial) {
    sanitized.unit = SUPERMARKET_DEFAULTS.unit;
  }

  const category = toNullableString(payload.category);
  if (category !== undefined) {
    sanitized.category = category;
  } else if (!partial) {
    sanitized.category = null;
  }

  const store = toNullableString(payload.store);
  if (store !== undefined) {
    sanitized.store = store;
  } else if (!partial) {
    sanitized.store = null;
  }

  const notes = toNullableString(payload.notes);
  if (notes !== undefined) {
    sanitized.notes = notes;
  } else if (!partial) {
    sanitized.notes = null;
  }

  const hasPrice = has('price');
  if (hasPrice) {
    if (payload.price === null || payload.price === '') {
      sanitized.price = null;
    } else {
      const price = Number(payload.price);
      if (!Number.isFinite(price) || price < 0) {
        errors.push('price');
      } else {
        sanitized.price = Math.round(price * 100) / 100;
      }
    }
  } else if (!partial) {
    sanitized.price = null;
  }

  const hasPriority = has('priority');
  if (hasPriority) {
    const priority = Number(payload.priority);
    if (!Number.isInteger(priority) || !SUPERMARKET_PRIORITY_VALUES.has(priority)) {
      errors.push('priority');
    } else {
      sanitized.priority = priority;
    }
  } else if (!partial) {
    sanitized.priority = SUPERMARKET_DEFAULTS.priority;
  }

  const hasChecked = has('checked');
  if (hasChecked) {
    const checked = parseCheckedValue(payload.checked);
    if (checked === null) {
      errors.push('checked');
    } else {
      sanitized.checked = checked;
    }
  } else if (!partial) {
    sanitized.checked = SUPERMARKET_DEFAULTS.checked;
  }

  const hasRecurring = has('recurring');
  if (hasRecurring) {
    const recurring = toTrimmedString(payload.recurring).toLowerCase();
    if (!recurring) {
      sanitized.recurring = SUPERMARKET_DEFAULTS.recurring;
    } else if (SUPERMARKET_RECURRING_VALUES.has(recurring)) {
      sanitized.recurring = recurring;
    } else {
      errors.push('recurring');
    }
  } else if (!partial) {
    sanitized.recurring = SUPERMARKET_DEFAULTS.recurring;
  }

  const hasTags = has('tags');
  if (hasTags) {
    const tags = sanitizeTagsValue(payload.tags);
    if (tags === null) {
      errors.push('tags');
    } else {
      sanitized.tags = tags;
    }
  } else if (!partial) {
    sanitized.tags = [...SUPERMARKET_DEFAULTS.tags];
  }

  if (errors.length) {
    return { error: 'Campos invalidos: ' + errors.join(', ') };
  }

  return { data: sanitized };
}

function mapSupermarketDoc(doc) {
  const data = doc.data() || {};
  const item = {
    id: doc.id,
    ...data,
  };
  if (typeof item.quantity !== 'number') item.quantity = SUPERMARKET_DEFAULTS.quantity;
  if (typeof item.unit !== 'string' || !item.unit.trim()) item.unit = SUPERMARKET_DEFAULTS.unit;
  if (!SUPERMARKET_PRIORITY_VALUES.has(item.priority)) item.priority = SUPERMARKET_DEFAULTS.priority;
  if (typeof item.checked !== 'boolean') item.checked = SUPERMARKET_DEFAULTS.checked;
  if (typeof item.recurring !== 'string' || !SUPERMARKET_RECURRING_VALUES.has(item.recurring)) item.recurring = SUPERMARKET_DEFAULTS.recurring;
  if (!Array.isArray(item.tags)) item.tags = [];
  if (item.category === undefined) item.category = null;
  if (item.store === undefined) item.store = null;
  if (item.notes === undefined) item.notes = null;
  if (item.price === undefined) item.price = null;

  const createdAtValue = getComparableTimestamp(data.createdAt || item.createdAt);
  item.createdAt = createdAtValue || null;
  const updatedAtValue = getComparableTimestamp(data.updatedAt || item.updatedAt);
  item.updatedAt = updatedAtValue || null;

  return item;
}

function sortSupermarketItems(items) {
  return items.sort((a, b) => {
    if (a.checked !== b.checked) {
      return a.checked ? 1 : -1;
    }
    const priorityA = SUPERMARKET_PRIORITY_VALUES.has(a.priority) ? a.priority : SUPERMARKET_DEFAULTS.priority;
    const priorityB = SUPERMARKET_PRIORITY_VALUES.has(b.priority) ? b.priority : SUPERMARKET_DEFAULTS.priority;
    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }
    const nameA = typeof a.name === 'string' ? a.name.toLowerCase() : '';
    const nameB = typeof b.name === 'string' ? b.name.toLowerCase() : '';
    if (nameA !== nameB) {
      return nameA.localeCompare(nameB);
    }
    const createdA = getComparableTimestamp(a.createdAt);
    const createdB = getComparableTimestamp(b.createdAt);
    return createdA.localeCompare(createdB);
  });
}

function computeSupermarketStats(items) {
  const total = items.length;
  let checked = 0;
  let estimate = 0;
  items.forEach(item => {
    if (item.checked) checked += 1;
    const quantity = typeof item.quantity === 'number' ? item.quantity : SUPERMARKET_DEFAULTS.quantity;
    if (typeof item.price === 'number' && Number.isFinite(item.price)) {
      estimate += item.price * quantity;
    }
  });
  return {
    total,
    checked,
    pending: total - checked,
    estimatedTotal: Math.round(estimate * 100) / 100,
  };
}

// =========================
// Google Sheets legacy routes
// =========================

router.get('/GetPendientes', async (req, res) => {
  try {
    const res_gd = await goo.readFileRange(g_files.fileIdAppP, 'Pendientes', 'A1:ZZ');

    if (!Array.isArray(res_gd)) {
      throw new Error('Error al leer el archivo de Google Sheets');
    }

    const headers = res_gd.shift();
    const result = {};

    headers.forEach((header, colIndex) => {
      result[header] = res_gd.map(row => row[colIndex]).filter(Boolean);
    });

    return res.status(200).json({ status: 'success', data: result });  } catch (error) {   console.error('[PENDIENTES] GetPendientes error', error);
           return res.status(500).json({      status: 'error',     message: 'Hubo un error al obtener los datos',    error: error.message    }); }});

router.post('/SavePendientes', async (req, res) => {
  try {
    const payload = req.body && req.body.data ? req.body.data : req.body;

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({
        status: 'error',
        message: 'El cuerpo debe ser un objeto con las columnas como llaves y listas como arreglos.'
      });
    }

    const headers = Object.keys(payload);
    const columns = headers.map(h => Array.isArray(payload[h]) ? payload[h] : []);

    const current = await goo.readFileRange(g_files.fileIdAppP, 'Pendientes', 'A1:ZZ');
    const currentCols = Array.isArray(current) && current.length > 0 ? (current[0] || []).length : 0;
    const currentRows = Array.isArray(current) ? current.length : 0;

    const maxItems = columns.reduce((m, arr) => Math.max(m, arr.length), 0);

    const width = Math.max(headers.length, currentCols);
    const height = Math.max(1 + maxItems, currentRows);

    const matrix = [];

    const headerRow = new Array(width).fill('');
    for (let c = 0; c < headers.length; c++) headerRow[c] = headers[c];
    matrix.push(headerRow);

    for (let r = 0; r < height - 1; r++) {
      const row = new Array(width).fill('');
      for (let c = 0; c < headers.length; c++) {
        row[c] = columns[c][r] || '';
      }
      matrix.push(row);
    }

    const updated = await goo.updateFile(g_files.fileIdAppP, 'Pendientes', 'A1', matrix);

    return res.status(200).json({ status: 'success', updatedCells: updated, message: 'Pendientes guardados correctamente.' });
    return res.status(500).json({
      status: 'error',
      message: 'Hubo un error al guardar los datos',
      error: error.message
    });
  }
  catch{

  }
});

function formatDateId(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseCalendarDate(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) {
    return formatDateId(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return formatDateId(new Date(value));
  }
  if (value && typeof value === 'object') {
    if (typeof value.toDate === 'function') {
      try {
        return formatDateId(value.toDate());
      } catch (error) {
        return null;
      }
    }
    if (typeof value.seconds === 'number') {
      return formatDateId(new Date(value.seconds * 1000));
    }
  }
  const trimmed = toTrimmedString(value);
  if (!trimmed) return null;
  const simpleMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (simpleMatch) {
    const year = Number(simpleMatch[1]);
    const month = Number(simpleMatch[2]);
    const day = Number(simpleMatch[3]);
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() + 1 !== month ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    return `${simpleMatch[1]}-${simpleMatch[2]}-${simpleMatch[3]}`;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatDateId(parsed);
}

function parseCalendarTime(value) {
  if (value === undefined) return { provided: false };
  if (value === null) return { provided: true, value: null };
  const trimmed = toTrimmedString(value);
  if (!trimmed) return { provided: true, value: null };
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!match) return { provided: true, error: true };
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] !== undefined ? Number(match[3]) : 0;
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return { provided: true, error: true };
  if (!Number.isInteger(seconds)) return { provided: true, error: true };
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
    return { provided: true, error: true };
  }
  const normalized = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  return { provided: true, value: normalized };
}

function parseNotifyBeforeMinutes(value) {
  if (value === undefined) return { provided: false };
  if (value === null || value === '') return { provided: true, value: null };
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return { provided: true, error: true };
  return { provided: true, value: Math.round(parsed) };
}

function sanitizeCalendarPayload(payload, { partial = false } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: 'El cuerpo debe ser un objeto' };
  }

  const sanitized = {};
  const errors = [];
  const has = key => Object.prototype.hasOwnProperty.call(payload, key);

  if (!partial || has('title')) {
    const title = toTrimmedString(payload.title);
    if (!title) {
      errors.push('title');
    } else {
      sanitized.title = title;
    }
  }

  if (!partial || has('date')) {
    const parsedDate = parseCalendarDate(payload.date);
    if (!parsedDate) {
      errors.push('date');
    } else {
      sanitized.date = parsedDate;
    }
  }

  if (has('description')) {
    const description = toNullableString(payload.description);
    sanitized.description = description === undefined ? null : description;
  } else if (!partial) {
    sanitized.description = null;
  }

  const startTimeResult = parseCalendarTime(payload.startTime);
  if (!partial || startTimeResult.provided) {
    if (startTimeResult.error) {
      errors.push('startTime');
    } else if (startTimeResult.provided) {
      sanitized.startTime = startTimeResult.value === undefined ? null : startTimeResult.value;
    } else if (!partial) {
      sanitized.startTime = null;
    }
  }

  const notifyResult = parseNotifyBeforeMinutes(payload.notifyBeforeMinutes);
  if (!partial || notifyResult.provided) {
    if (notifyResult.error) {
      errors.push('notifyBeforeMinutes');
    } else if (notifyResult.provided) {
      sanitized.notifyBeforeMinutes = notifyResult.value === undefined ? null : notifyResult.value;
    } else if (!partial) {
      sanitized.notifyBeforeMinutes = null;
    }
  }

  if (errors.length) {
    return { errors };
  }

  if (!partial) {
    const now = nowIso();
    sanitized.createdAt = now;
    sanitized.updatedAt = now;
    if (!Object.prototype.hasOwnProperty.call(sanitized, 'description')) {
      sanitized.description = null;
    }
    if (!Object.prototype.hasOwnProperty.call(sanitized, 'startTime')) {
      sanitized.startTime = null;
    }
    if (!Object.prototype.hasOwnProperty.call(sanitized, 'notifyBeforeMinutes')) {
      sanitized.notifyBeforeMinutes = null;
    }
  } else if (Object.keys(sanitized).length) {
    sanitized.updatedAt = nowIso();
  }

  return { sanitized };
}

function mapCalendarDocument(doc) {
  const data = doc.data() || {};
  const parsedDate = parseCalendarDate(data.date);
  const startResult = parseCalendarTime(data.startTime);
  const notifyResult = parseNotifyBeforeMinutes(data.notifyBeforeMinutes);
  const notifyValue =
    notifyResult.provided && !notifyResult.error ? notifyResult.value : null;
  return {
    id: doc.id,
    title: typeof data.title === 'string' ? data.title : '',
    description: typeof data.description === 'string' && data.description.trim()
      ? data.description
      : null,
    date: parsedDate,
    startTime: startResult.error ? null : startResult.value ?? null,
    notifyBeforeMinutes: notifyValue,
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
  };
}

function sortCalendarEventsForResponse(items) {
  return items.sort((a, b) => {
    const dateA = a.date || '';
    const dateB = b.date || '';
    if (dateA !== dateB) {
      if (!dateA) return 1;
      if (!dateB) return -1;
      return dateA.localeCompare(dateB);
    }
    const timeA = a.startTime || '';
    const timeB = b.startTime || '';
    if (timeA !== timeB) {
      if (!timeA) return 1;
      if (!timeB) return -1;
      return timeA.localeCompare(timeB);
    }
    const createdA = (a.createdAt || '').toString();
    const createdB = (b.createdAt || '').toString();
    if (createdA && createdB && createdA !== createdB) {
      return createdA.localeCompare(createdB);
    }
    return a.id.localeCompare(b.id);
  });
}

async function loadCalendarEventsFromCollections(database) {
  const merged = new Map();
  for (const collectionName of CALENDAR_COLLECTION_CANDIDATES) {
    try {
      const snapshot = await database.collection(collectionName).get();
      if (snapshot.empty) continue;
      snapshot.docs.forEach(doc => {
        const mapped = mapCalendarDocument(doc);
        if (!mapped || !mapped.id) return;
        if (!merged.has(mapped.id)) {
          merged.set(mapped.id, mapped);
        }
      });
    } catch (error) {
      console.warn('[CALENDAR] load collection error', { collectionName, error: error.message });
    }
  }
  return Array.from(merged.values());
}

async function findCalendarDocument(database, eventId) {
  for (const collectionName of CALENDAR_COLLECTION_CANDIDATES) {
    const docRef = database.collection(collectionName).doc(eventId);
    const snapshot = await docRef.get();
    if (snapshot.exists) {
      return { collectionName, docRef, snapshot };
    }
  }
  return null;
}

// =========================
// Firestore routes - calendar
// =========================

router.get('/calendar', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const startDateRaw = toTrimmedString(req.query.startDate);
    const endDateRaw = toTrimmedString(req.query.endDate);
    const startDate = startDateRaw ? parseCalendarDate(startDateRaw) : null;
    const endDate = endDateRaw ? parseCalendarDate(endDateRaw) : null;

    if (startDateRaw && !startDate) {
      return res.status(400).json({ status: 'error', message: 'Fecha de inicio invalida' });
    }
    if (endDateRaw && !endDate) {
      return res.status(400).json({ status: 'error', message: 'Fecha de fin invalida' });
    }
    if (startDate && endDate && endDate < startDate) {
      return res.status(400).json({ status: 'error', message: 'El rango de fechas es invalido' });
    }

    const items = (await loadCalendarEventsFromCollections(database)).filter(event => !!event.date);

    let filtered = items;
    if (startDate) {
      filtered = filtered.filter(event => event.date && event.date >= startDate);
    }
    if (endDate) {
      filtered = filtered.filter(event => event.date && event.date <= endDate);
    }

    const data = sortCalendarEventsForResponse(filtered);
    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    console.error('[CALENDAR] list error', error);
    return res.status(500).json({ status: 'error', message: 'No se pudo obtener el calendario' });
  }
});

router.post('/calendar', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const payload = req.body && Object.prototype.hasOwnProperty.call(req.body, 'data') ? req.body.data : req.body;
    const { error, errors, sanitized } = sanitizeCalendarPayload(payload || {}, { partial: false });

    if (error) {
      return res.status(400).json({ status: 'error', message: error });
    }
    if (errors && errors.length) {
      return res.status(400).json({ status: 'error', message: `Campos invalidos: ${errors.join(', ')}` });
    }

    const ref = await database.collection(CALENDAR_COLLECTION).add(sanitized);
    const createdEvent = { id: ref.id, ...sanitized };

    const title = sanitized.title || 'Nuevo evento';
    const scheduleParts = [];
    if (sanitized.date) {
      scheduleParts.push(`Fecha ${sanitized.date}`);
    }
    if (sanitized.startTime) {
      scheduleParts.push(`Hora ${sanitized.startTime}`);
    }
    const descriptionSnippet = truncateText(sanitized.description || '', 90);
    if (descriptionSnippet) {
      scheduleParts.push(descriptionSnippet);
    }
    const body = scheduleParts.join(' | ');

    const hasReminderConfig =
      typeof sanitized.notifyBeforeMinutes === 'number' &&
      Number.isFinite(sanitized.notifyBeforeMinutes) &&
      sanitized.notifyBeforeMinutes >= 0 &&
      typeof sanitized.startTime === 'string' &&
      sanitized.startTime.trim().length > 0;

    if (!hasReminderConfig) {
      await notifyEntityCreated({
        title: `Nuevo evento: ${title}`,
        body,
        data: {
          entityType: 'calendar',
          action: 'created',
          eventId: ref.id,
          title,
          date: sanitized.date || null,
          startTime: sanitized.startTime || null,
        },
      });
    } else {
      console.log('[CALENDAR] skipping immediate push for scheduled event', {
        eventId: ref.id,
        notifyBeforeMinutes: sanitized.notifyBeforeMinutes,
        startTime: sanitized.startTime,
      });
    }

    return res.status(201).json({ status: 'success', data: createdEvent });
  } catch (error) {
    console.error('[CALENDAR] create error', error);
    return res.status(500).json({ status: 'error', message: 'No se pudo crear el evento' });
  }
});

router.patch('/calendar/:id', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const eventId = toTrimmedString(req.params.id);
    if (!eventId) {
      return res.status(400).json({ status: 'error', message: 'ID de evento invalido' });
    }

    const payload = req.body && Object.prototype.hasOwnProperty.call(req.body, 'data') ? req.body.data : req.body;
    const { error, errors, sanitized } = sanitizeCalendarPayload(payload || {}, { partial: true });
    if (error) {
      return res.status(400).json({ status: 'error', message: error });
    }
    if (errors && errors.length) {
      return res.status(400).json({ status: 'error', message: `Campos invalidos: ${errors.join(', ')}` });
    }

    const fields = Object.keys(sanitized || {});
    if (!fields.length) {
      return res.status(400).json({ status: 'error', message: 'No hay cambios para aplicar' });
    }

    const resolved = await findCalendarDocument(database, eventId);
    if (!resolved) {
      return res.status(404).json({ status: 'error', message: 'Evento no encontrado' });
    }

    const { docRef } = resolved;
    await docRef.set(sanitized, { merge: true });
    const updated = await docRef.get();
    const mappedEvent = mapCalendarDocument(updated);

    const eventTitle = mappedEvent.title || 'Evento';
    const scheduleParts = [];
    if (mappedEvent.date) {
      scheduleParts.push(`Fecha ${mappedEvent.date}`);
    }
    if (mappedEvent.startTime) {
      scheduleParts.push(`Hora ${mappedEvent.startTime}`);
    }
    const descriptionSnippet = truncateText(mappedEvent.description || '', 90);
    if (descriptionSnippet) {
      scheduleParts.push(descriptionSnippet);
    }
    const body = scheduleParts.join(' | ');

    await notifyEntityUpdated({
      title: `Evento actualizado: ${eventTitle}`,
      body,
      data: {
        entityType: 'calendar',
        eventId,
        title: eventTitle,
        date: mappedEvent.date || null,
        startTime: mappedEvent.startTime || null,
      },
    });

    return res.status(200).json({ status: 'success', data: mappedEvent });
  } catch (error) {
    console.error('[CALENDAR] update error', error);
    return res.status(500).json({ status: 'error', message: 'No se pudo actualizar el evento' });
  }
});

router.delete('/calendar/:id', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const eventId = toTrimmedString(req.params.id);
    if (!eventId) {
      return res.status(400).json({ status: 'error', message: 'ID de evento invalido' });
    }

    const resolved = await findCalendarDocument(database, eventId);
    if (!resolved) {
      return res.status(404).json({ status: 'error', message: 'Evento no encontrado' });
    }

    await resolved.docRef.delete();
    return res.status(200).json({ status: 'success', data: { id: eventId } });
  } catch (error) {
    console.error('[CALENDAR] delete error', error);
    return res.status(500).json({ status: 'error', message: 'No se pudo eliminar el evento' });
  }
});

function sanitizeNotePayload(payload, { partial = false } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: 'El cuerpo debe ser un objeto' };
  }

  const sanitized = {};
  const errors = [];
  const has = key => Object.prototype.hasOwnProperty.call(payload, key);

  const titleSource = has('title') ? payload.title : (has('name') ? payload.name : undefined);
  if (!partial || titleSource !== undefined) {
    const title = toTrimmedString(titleSource);
    if (!title) {
      errors.push('title');
    } else {
      sanitized.title = title;
    }
  }

  const contentKey = ['content', 'body', 'descripcion', 'description'].find(key => has(key));
  if (!partial || contentKey !== undefined) {
    const rawContent = contentKey !== undefined ? payload[contentKey] : '';
    const contentValue = toNullableString(rawContent);
    sanitized.content = contentValue === undefined || contentValue === null ? '' : contentValue;
  }

  let typeValue;
  if (has('type')) {
    typeValue = toTrimmedString(payload.type).toLowerCase();
  } else if (has('noteType')) {
    typeValue = toTrimmedString(payload.noteType).toLowerCase();
  }
  if (typeValue) {
    if (!NOTE_TYPES.has(typeValue)) {
      errors.push('type');
    } else {
      sanitized.type = typeValue;
    }
  }

  if (has('isManzana')) {
    const rawFlag = payload.isManzana;
    if (typeof rawFlag === 'boolean') {
      sanitized.isManzana = rawFlag;
    } else if (typeof rawFlag === 'string') {
      const normalized = rawFlag.trim().toLowerCase();
      sanitized.isManzana = ['true', '1', 'yes', 'si', 'sí'].includes(normalized);
    } else if (typeof rawFlag === 'number') {
      sanitized.isManzana = rawFlag === 1;
    }
  }

  if (!partial) {
    if (!sanitized.title) {
      errors.push('title');
    }
    if (!sanitized.type) {
      sanitized.type = DEFAULT_NOTE_TYPE;
    }
    if (sanitized.isManzana === undefined) {
      sanitized.isManzana = sanitized.type === 'manzana';
    }
  } else {
    if (sanitized.type && sanitized.isManzana === undefined) {
      sanitized.isManzana = sanitized.type === 'manzana';
    }
  }

  if (sanitized.isManzana) {
    sanitized.type = 'manzana';
  }

  if (errors.length) {
    return { errors };
  }

  const now = nowIso();
  sanitized.updatedAt = now;
  if (!partial) {
    sanitized.createdAt = now;
    if (!Object.prototype.hasOwnProperty.call(sanitized, 'content')) {
      sanitized.content = '';
    }
  }

  return { sanitized };
}

function mapNoteDocument(doc) {
  const data = doc.data() || {};
  const typeValue = toTrimmedString(data.type).toLowerCase();
  const type = NOTE_TYPES.has(typeValue) ? typeValue : DEFAULT_NOTE_TYPE;
  const isManzana = typeof data.isManzana === 'boolean' ? data.isManzana : type === 'manzana';
  return {
    id: doc.id,
    title: typeof data.title === 'string' ? data.title : '',
    content: typeof data.content === 'string' ? data.content : '',
    type: isManzana ? 'manzana' : type,
    isManzana,
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
  };
}

function sortNotesForResponse(items) {
  return items.sort((a, b) => {
    if (!!a.isManzana !== !!b.isManzana) {
      return a.isManzana ? -1 : 1;
    }
    const updatedA = (a.updatedAt || a.createdAt || '').toString();
    const updatedB = (b.updatedAt || b.createdAt || '').toString();
    if (updatedA && updatedB && updatedA !== updatedB) {
      return updatedB.localeCompare(updatedA);
    }
    if (a.title !== b.title) {
      return a.title.localeCompare(b.title);
    }
    return a.id.localeCompare(b.id);
  });
}
// =========================
// Firestore routes - notes
// =========================

router.get('/notes', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const snapshot = await database.collection(NOTES_COLLECTION).get();
    const items = sortNotesForResponse(snapshot.docs.map(mapNoteDocument));
    return res.status(200).json({ status: 'success', data: items });
  } catch (error) {
    console.error('[NOTES] list error', error);
    return res.status(500).json({ status: 'error', message: 'No se pudieron obtener las notas' });
  }
});

router.post('/notes', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const payload = req.body && Object.prototype.hasOwnProperty.call(req.body, 'data') ? req.body.data : req.body;
    const { error, errors, sanitized } = sanitizeNotePayload(payload || {}, { partial: false });

    if (error) {
      return res.status(400).json({ status: 'error', message: error });
    }

    if (errors && errors.length) {
      return res.status(400).json({ status: 'error', message: `Campos invalidos: ${errors.join(', ')}` });
    }

    const ref = await database.collection(NOTES_COLLECTION).add(sanitized);
    const createdNote = { id: ref.id, ...sanitized };

    const noteTitle = sanitized.title || 'Nota nueva';
    const contentSnippet = truncateText(sanitized.content || '', 120) || 'Nota sin contenido';

    await notifyEntityCreated({
      title: `Nueva nota: ${noteTitle}`,
      body: contentSnippet,
      data: {
        entityType: 'note',
        action: 'created',
        noteId: ref.id,
        title: noteTitle,
        type: sanitized.type || null,
        isManzana: sanitized.isManzana ?? null,
      },
    });

    return res.status(201).json({ status: 'success', data: createdNote });
  } catch (error) {
    console.error('[NOTES] create error', error);
    return res.status(500).json({ status: 'error', message: 'No se pudo guardar la nota' });
  }
});

router.put('/notes/:id', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const noteId = toTrimmedString(req.params.id);
    if (!noteId) {
      return res.status(400).json({ status: 'error', message: 'ID de nota invalido' });
    }

    const payload = req.body && Object.prototype.hasOwnProperty.call(req.body, 'data') ? req.body.data : req.body;
    const { error, errors, sanitized } = sanitizeNotePayload(payload || {}, { partial: true });

    if (error) {
      return res.status(400).json({ status: 'error', message: error });
    }

    if (errors && errors.length) {
      return res.status(400).json({ status: 'error', message: `Campos invalidos: ${errors.join(', ')}` });
    }

    const fields = Object.keys(sanitized).filter(key => key !== 'updatedAt');
    if (!fields.length) {
      return res.status(400).json({ status: 'error', message: 'No hay cambios para aplicar' });
    }

    const docRef = database.collection(NOTES_COLLECTION).doc(noteId);
    const snapshot = await docRef.get();
    if (!snapshot.exists) {
      return res.status(404).json({ status: 'error', message: 'Nota no encontrada' });
    }

    await docRef.set(sanitized, { merge: true });
    const updated = await docRef.get();
    const mappedNote = mapNoteDocument(updated);

    const noteTitle = mappedNote.title || 'Nota';
    const contentSnippet = truncateText(mappedNote.content || '', 120) || 'Nota actualizada.';

    await notifyEntityUpdated({
      title: `Nota actualizada: ${noteTitle}`,
      body: contentSnippet,
      data: {
        entityType: 'note',
        noteId,
        title: noteTitle,
        type: mappedNote.type || null,
        isManzana: mappedNote.isManzana ?? null,
      },
    });

    return res.status(200).json({ status: 'success', data: mappedNote });
  } catch (error) {
    console.error('[NOTES] update error', error);
    return res.status(500).json({ status: 'error', message: 'No se pudo actualizar la nota' });
  }
});

router.delete('/notes/:id', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const noteId = toTrimmedString(req.params.id);
    if (!noteId) {
      return res.status(400).json({ status: 'error', message: 'ID de nota invalido' });
    }

    const docRef = database.collection(NOTES_COLLECTION).doc(noteId);
    const snapshot = await docRef.get();
    if (!snapshot.exists) {
      return res.status(404).json({ status: 'error', message: 'Nota no encontrada' });
    }

    await docRef.delete();
    return res.status(200).json({ status: 'success', data: { id: noteId } });
  } catch (error) {
    console.error('[NOTES] delete error', error);
    return res.status(500).json({ status: 'error', message: 'No se pudo eliminar la nota' });
  }
});
// =========================
// Firestore routes - categories and tasks
// =========================

router.get('/categories', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const includeTasks = req.query.includeTasks === 'true';
    const includeTaskCounts = includeTasks || req.query.includeTaskCounts === 'true';

    const snapshot = await loadCategoriesSnapshot(database);
    const docs = snapshot.docs;

    const items = await Promise.all(docs.map(async (doc) => {
      const category = mapCategoryData(doc);
      if (includeTasks) {
        const tasksSnap = await getTasksSnapshot(doc.ref);
        category.tasks = tasksSnap.docs.map(mapTaskData);
        category.tasksCount = category.tasks.length;
      } else if (includeTaskCounts) {
        category.tasksCount = await getTaskCount(doc.ref);
      }
      if (typeof category.tasksCount === 'undefined') {
        category.tasksCount = category.tasksCount || 0;
      }
      if (typeof category.order !== 'number') {
        const orderValue = parseOrderValue(doc.get('order'));
        if (orderValue !== null) {
          category.order = orderValue;
        }
      }
      return category;
    }));

    return res.status(200).json({ status: 'success', data: items });
  } catch (error) {
      return res.status(500).json({ status: 'error', message: 'Error al listar categorias', error: error.message });
  }
});

router.post('/categories', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const payload = req.body && req.body.data ? req.body.data : req.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ status: 'error', message: 'El cuerpo debe ser un objeto' });
    }

    const title = (payload.title || payload.name || payload.nombre || '').toString().trim();
    if (!title) {
      return res.status(400).json({ status: 'error', message: 'El campo "title" es obligatorio' });
    }

    const now = nowIso();
    const providedOrder = parseOrderValue(payload.order);
    const order = providedOrder !== null ? providedOrder : Date.now();
    const newCategory = {
      title,
      description: typeof payload.description === 'string' ? payload.description : (typeof payload.descripcion === 'string' ? payload.descripcion : ''),
      color: payload.color || null,
      order,
      createdAt: now,
      updatedAt: now,
    };

    const ref = await database.collection(FS_COLLECTION).add(newCategory);
    return res.status(201).json({ status: 'success', data: { id: ref.id, tasksCount: 0, ...newCategory } });
  } catch (error) {
      return res.status(500).json({ status: 'error', message: 'Error al crear la categoria', error: error.message });
  }
});

router.post('/categories/reorder', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const rawBody = req.body && Object.prototype.hasOwnProperty.call(req.body, 'data') ? req.body.data : req.body;
    let entries = null;

    if (Array.isArray(rawBody)) {
      entries = rawBody;
    } else if (rawBody && typeof rawBody === 'object') {
      if (Array.isArray(rawBody.categories)) {
        entries = rawBody.categories;
      } else if (Array.isArray(rawBody.items)) {
        entries = rawBody.items;
      } else if (Array.isArray(rawBody.data)) {
        entries = rawBody.data;
      }
    }

    if (!entries || !entries.length) {
      return res.status(400).json({ status: 'error', message: 'Se requiere un arreglo de categorias para reordenar' });
    }

    const normalized = [];
    const seenIds = new Set();

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry || typeof entry !== 'object') {
        return res.status(400).json({ status: 'error', message: 'Entrada ' + i + ' invalida' });
      }
      const categoryId = (entry.id || entry.categoryId || entry.cid || '').toString().trim();
      if (!categoryId) {
        return res.status(400).json({ status: 'error', message: 'La entrada ' + i + ' no tiene id de categoria' });
      }
      if (seenIds.has(categoryId)) {
        return res.status(400).json({ status: 'error', message: 'La categoria ' + categoryId + ' esta duplicada en el reordenamiento' });
      }
      const orderSource = Object.prototype.hasOwnProperty.call(entry, 'order')
        ? entry.order
        : (Object.prototype.hasOwnProperty.call(entry, 'position') ? entry.position : undefined);
      const orderNumber = Number(orderSource);
      if (!Number.isFinite(orderNumber)) {
        return res.status(400).json({ status: 'error', message: 'La categoria ' + categoryId + ' requiere un valor numerico para order' });
      }
      seenIds.add(categoryId);
      normalized.push({ categoryId, order: Math.trunc(orderNumber) });
    }

    const collectionRef = database.collection(FS_COLLECTION);
    const existingSnap = await collectionRef.get();
    const existingIds = new Set(existingSnap.docs.map(doc => doc.id));
    const missing = normalized.filter(item => !existingIds.has(item.categoryId)).map(item => item.categoryId);
    if (missing.length) {
      return res.status(404).json({ status: 'error', message: 'No se encontraron las categorias: ' + missing.join(', ') });
    }

    const batch = database.batch();
    const now = nowIso();
    normalized.forEach(({ categoryId, order }) => {
      batch.update(collectionRef.doc(categoryId), { order, updatedAt: now });
    });

    await batch.commit();
    return res.status(200).json({ status: 'success', message: 'Orden de categorias actualizado', count: normalized.length });
  } catch (error) {
      return res.status(500).json({ status: 'error', message: 'Error al reordenar categorias', error: error.message });
  }
});

router.get('/categories/:id', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const { id } = req.params;
    const includeTasks = req.query.includeTasks !== 'false';

    const ref = database.collection(FS_COLLECTION).doc(id);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ status: 'error', message: 'Categoria no encontrada' });
    }

    const category = mapCategoryData(snap);
    const orderValue = parseOrderValue(snap.get('order'));
    if (orderValue !== null) {
      category.order = orderValue;
    }
    if (includeTasks) {
      const tasksSnap = await getTasksSnapshot(ref);
      category.tasks = tasksSnap.docs.map(mapTaskData);
      category.tasksCount = category.tasks.length;
    } else {
      category.tasksCount = await getTaskCount(ref);
    }

    return res.status(200).json({ status: 'success', data: category });
  } catch (error) {
      return res.status(500).json({ status: 'error', message: 'Error al obtener la categoria', error: error.message });
  }
});

router.put('/categories/:id', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const payload = req.body && req.body.data ? req.body.data : req.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ status: 'error', message: 'El cuerpo debe ser un objeto' });
    }

    const { id } = req.params;
    const ref = database.collection(FS_COLLECTION).doc(id);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ status: 'error', message: 'Categoria no encontrada' });
    }

    const updates = {};
    if (payload.title || payload.name || payload.nombre) {
      const title = (payload.title || payload.name || payload.nombre || '').toString().trim();
      if (!title) {
        return res.status(400).json({ status: 'error', message: 'El campo "title" no puede estar vacio' });
      }
      updates.title = title;
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'description') || Object.prototype.hasOwnProperty.call(payload, 'descripcion')) {
      const description = typeof payload.description === 'string' ? payload.description : (typeof payload.descripcion === 'string' ? payload.descripcion : '');
      updates.description = description;
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'color')) {
      updates.color = payload.color || null;
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'order')) {
      const orderValue = parseOrderValue(payload.order);
      if (orderValue === null) {
        return res.status(400).json({ status: 'error', message: 'El campo "order" debe ser numerico' });
      }
      updates.order = orderValue;
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ status: 'error', message: 'No hay cambios para aplicar' });
    }

    updates.updatedAt = nowIso();

    await ref.set(updates, { merge: true });
    return res.status(200).json({ status: 'success', message: 'Categoria actualizada' });
  } catch (error) {
      return res.status(500).json({ status: 'error', message: 'Error al actualizar la categoria', error: error.message });
  }
});

router.delete('/categories/:id', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const { id } = req.params;
    const ref = database.collection(FS_COLLECTION).doc(id);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ status: 'error', message: 'Categoria no encontrada' });
    }

    const tasksSnap = await ref.collection(FS_TASKS_SUBCOL).get();
    const batchDeletes = tasksSnap.docs.map(doc => doc.ref.delete());
    await Promise.all(batchDeletes);

    await ref.delete();
    return res.status(200).json({ status: 'success', message: 'Categoria eliminada' });
  } catch (error) {
      return res.status(500).json({ status: 'error', message: 'Error al eliminar la categoria', error: error.message });
  }
});

router.get('/categories/:id/tasks', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const { id } = req.params;
    const categoryRef = database.collection(FS_COLLECTION).doc(id);
    const categorySnap = await categoryRef.get();
    if (!categorySnap.exists) {
      return res.status(404).json({ status: 'error', message: 'Categoria no encontrada' });
    }

    const tasksSnap = await getTasksSnapshot(categoryRef);
    const tasks = tasksSnap.docs.map(mapTaskData);

    return res.status(200).json({ status: 'success', data: tasks, count: tasks.length, statusCatalog: TASK_STATUSES });
  } catch (error) {
      return res.status(500).json({ status: 'error', message: 'Error al listar tareas', error: error.message });
  }
});

router.post('/categories/:id/tasks', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const payload = req.body && req.body.data ? req.body.data : req.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ status: 'error', message: 'El cuerpo debe ser un objeto' });
    }

    const { id } = req.params;
    const categoryRef = database.collection(FS_COLLECTION).doc(id);
    const categorySnap = await categoryRef.get();
    if (!categorySnap.exists) {
      return res.status(404).json({ status: 'error', message: 'Categoria no encontrada' });
    }

    const name = (payload.title || payload.name || payload.nombre || '').toString().trim();
    if (!name) {
      return res.status(400).json({ status: 'error', message: 'El campo "title" es obligatorio' });
    }

    const status = normalizeTaskStatus(payload.status || payload.estatus || payload.state);
    if (!status) {
      return res.status(400).json({ status: 'error', message: 'Estatus de tarea no valido', validStatus: TASK_STATUSES });
    }

    const orderSource = Object.prototype.hasOwnProperty.call(payload, 'order')
      ? payload.order
      : (Object.prototype.hasOwnProperty.call(payload, 'position') ? payload.position : undefined);
    const orderNumber = Number(orderSource);
    const order = Number.isFinite(orderNumber) ? Math.trunc(orderNumber) : Date.now();

    const now = nowIso();
    const newTask = {
      title: name,
      description: typeof payload.description === 'string' ? payload.description : (typeof payload.descripcion === 'string' ? payload.descripcion : ''),
      status,
      dueDate: payload.dueDate || payload.fecha || null,
      order,
      createdAt: now,
      updatedAt: now
    };

    const ref = await categoryRef.collection(FS_TASKS_SUBCOL).add(newTask);
    const createdTask = { id: ref.id, ...newTask };
    const categoryData = categorySnap.data() || {};
    const categoryTitle =
      typeof categoryData.title === 'string' && categoryData.title.trim()
        ? categoryData.title.trim()
        : 'Pendientes';

    const bodyParts = [];
    if (newTask.dueDate) {
      bodyParts.push(`Fecha limite ${newTask.dueDate}`);
    }
    const descriptionSnippet = truncateText(newTask.description || '', 90);
    if (descriptionSnippet) {
      bodyParts.push(descriptionSnippet);
    }
    const body = bodyParts.join(' | ');

    await notifyEntityCreated({
      title: `Nueva tarea en ${categoryTitle}`,
      body: body || newTask.title,
      data: {
        entityType: 'task',
        action: 'created',
        taskId: ref.id,
        categoryId: id,
        categoryTitle,
        title: newTask.title,
        status: newTask.status,
        dueDate: newTask.dueDate || null,
      },
    });

    return res.status(201).json({ status: 'success', data: createdTask });
  } catch (error) {
      return res.status(500).json({ status: 'error', message: 'Error al crear la tarea', error: error.message });
  }
});

router.post('/categories/:id/tasks/reorder', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const rawBody = req.body && Object.prototype.hasOwnProperty.call(req.body, 'data') ? req.body.data : req.body;
    let entries = null;

    if (Array.isArray(rawBody)) {
      entries = rawBody;
    } else if (rawBody && typeof rawBody === 'object') {
      if (Array.isArray(rawBody.tasks)) {
        entries = rawBody.tasks;
      } else if (Array.isArray(rawBody.items)) {
        entries = rawBody.items;
      } else if (Array.isArray(rawBody.data)) {
        entries = rawBody.data;
      }
    }

    if (!entries || !entries.length) {
      return res.status(400).json({ status: 'error', message: 'Se requiere un arreglo de tareas para reordenar' });
    }

    const normalized = [];
    const seenIds = new Set();

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry || typeof entry !== 'object') {
        return res.status(400).json({ status: 'error', message: 'Entrada ' + i + ' invalida' });
      }
      const taskId = (entry.id || entry.taskId || entry.tid || '').toString().trim();
      if (!taskId) {
        return res.status(400).json({ status: 'error', message: 'La entrada ' + i + ' no tiene id de tarea' });
      }
      if (seenIds.has(taskId)) {
        return res.status(400).json({ status: 'error', message: 'La tarea ' + taskId + ' esta duplicada en el reordenamiento' });
      }
      const orderSource = Object.prototype.hasOwnProperty.call(entry, 'order')
        ? entry.order
        : (Object.prototype.hasOwnProperty.call(entry, 'position') ? entry.position : undefined);
      const orderNumber = Number(orderSource);
      if (!Number.isFinite(orderNumber)) {
        return res.status(400).json({ status: 'error', message: 'La tarea ' + taskId + ' requiere un valor numerico para order' });
      }
      seenIds.add(taskId);
      normalized.push({ taskId, order: Math.trunc(orderNumber) });
    }

    const { id } = req.params;
    const categoryRef = database.collection(FS_COLLECTION).doc(id);
    const categorySnap = await categoryRef.get();
    if (!categorySnap.exists) {
      return res.status(404).json({ status: 'error', message: 'Categoria no encontrada' });
    }

    const tasksSnap = await categoryRef.collection(FS_TASKS_SUBCOL).get();
    const existingIds = new Set(tasksSnap.docs.map(doc => doc.id));
    const missing = normalized
      .filter(item => !existingIds.has(item.taskId))
      .map(item => item.taskId);
    if (missing.length) {
      return res.status(404).json({ status: 'error', message: 'No se encontraron las tareas: ' + missing.join(', ') });
    }

    const batch = database.batch();
    const now = nowIso();
    normalized.forEach(({ taskId, order }) => {
      const taskRef = categoryRef.collection(FS_TASKS_SUBCOL).doc(taskId);
      batch.update(taskRef, { order, updatedAt: now });
    });

    await batch.commit();
    return res.status(200).json({ status: 'success', message: 'Orden actualizado', count: normalized.length });
  } catch (error) {
      return res.status(500).json({ status: 'error', message: 'Error al reordenar tareas', error: error.message });
  }
});

router.patch('/categories/:id/tasks/:taskId', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const payload = req.body && req.body.data ? req.body.data : req.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ status: 'error', message: 'El cuerpo debe ser un objeto' });
    }

    const { id, taskId } = req.params;
    const categoryRef = database.collection(FS_COLLECTION).doc(id);
    const taskRef = categoryRef.collection(FS_TASKS_SUBCOL).doc(taskId);

    const [categorySnap, taskSnap] = await Promise.all([categoryRef.get(), taskRef.get()]);
    if (!categorySnap.exists) {
      return res.status(404).json({ status: 'error', message: 'Categoria no encontrada' });
    }
    if (!taskSnap.exists) {
      return res.status(404).json({ status: 'error', message: 'Tarea no encontrada' });
    }

    const updates = {};
    if (payload.title || payload.name || payload.nombre) {
      const name = (payload.title || payload.name || payload.nombre || '').toString().trim();
      if (!name) {
        return res.status(400).json({ status: 'error', message: 'El campo "title" no puede estar vacio' });
      }
      updates.title = name;
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'description') || Object.prototype.hasOwnProperty.call(payload, 'descripcion')) {
      const description = typeof payload.description === 'string' ? payload.description : (typeof payload.descripcion === 'string' ? payload.descripcion : '');
      updates.description = description;
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'dueDate') || Object.prototype.hasOwnProperty.call(payload, 'fecha')) {
      updates.dueDate = payload.dueDate || payload.fecha || null;
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'order') || Object.prototype.hasOwnProperty.call(payload, 'position')) {
      const orderSource = Object.prototype.hasOwnProperty.call(payload, 'order') ? payload.order : payload.position;
      const orderNumber = Number(orderSource);
      if (!Number.isFinite(orderNumber)) {
        return res.status(400).json({ status: 'error', message: 'El campo \"order\" debe ser numerico' });
      }
      updates.order = Math.trunc(orderNumber);
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'status') || Object.prototype.hasOwnProperty.call(payload, 'estatus') || Object.prototype.hasOwnProperty.call(payload, 'state')) {
      const status = normalizeTaskStatus(payload.status || payload.estatus || payload.state);
      if (!status) {
        return res.status(400).json({ status: 'error', message: 'Estatus de tarea no valido', validStatus: TASK_STATUSES });
      }
      updates.status = status;
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ status: 'error', message: 'No hay cambios para aplicar' });
    }

    updates.updatedAt = nowIso();

    await taskRef.set(updates, { merge: true });
    const updatedTaskSnap = await taskRef.get();
    const updatedTask = mapTaskData(updatedTaskSnap);
    const categoryTitle =
      typeof categorySnap.get('title') === 'string' && categorySnap.get('title').trim()
        ? categorySnap.get('title').trim()
        : 'Pendientes';

    const descriptionSnippet = truncateText(updatedTask.description || '', 90);
    const bodyParts = [];
    if (updatedTask.dueDate) {
      bodyParts.push(`Fecha limite ${updatedTask.dueDate}`);
    }
    if (descriptionSnippet) {
      bodyParts.push(descriptionSnippet);
    }
    const body = bodyParts.join(' | ');

    await notifyEntityUpdated({
      title: `Tarea actualizada en ${categoryTitle}`,
      body: body || updatedTask.title || 'Se actualizó una tarea.',
      data: {
        entityType: 'task',
        taskId,
        categoryId: id,
        categoryTitle,
        title: updatedTask.title || null,
        status: updatedTask.status || null,
        dueDate: updatedTask.dueDate || null,
      },
    });

    return res.status(200).json({ status: 'success', message: 'Tarea actualizada', data: updatedTask });
  } catch (error) {
      return res.status(500).json({ status: 'error', message: 'Error al actualizar la tarea', error: error.message });
  }
});

router.delete('/categories/:id/tasks/:taskId', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const { id, taskId } = req.params;
    const categoryRef = database.collection(FS_COLLECTION).doc(id);
    const taskRef = categoryRef.collection(FS_TASKS_SUBCOL).doc(taskId);

    const [categorySnap, taskSnap] = await Promise.all([categoryRef.get(), taskRef.get()]);
    if (!categorySnap.exists) {
      return res.status(404).json({ status: 'error', message: 'Categoria no encontrada' });
    }
    if (!taskSnap.exists) {
      return res.status(404).json({ status: 'error', message: 'Tarea no encontrada' });
    }

    await taskRef.delete();
    return res.status(200).json({ status: 'success', message: 'Tarea eliminada' });
  } catch (error) {
      return res.status(500).json({ status: 'error', message: 'Error al eliminar la tarea', error: error.message });
  }
});

// =========================
// Supermarket routes
// =========================

async function updateSupermarketItem(req, res, { partial }) {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const payload = req.body && req.body.data ? req.body.data : req.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ status: 'error', message: 'El cuerpo debe ser un objeto' });
    }

    const { id } = req.params;
    const trimmedId = typeof id === 'string' ? id.trim() : String(id || '').trim();
    console.log('[SUPERMARKET] incoming update', { id: trimmedId, raw: payload, partial });
    if (!trimmedId) {
      return res.status(400).json({ status: 'error', message: 'Identificador de producto invalido' });
    }

    const docRef = database.collection(SUPERMARKET_COLLECTION).doc(trimmedId);
    const snapshot = await docRef.get();
    if (!snapshot.exists) {
      return res.status(404).json({ status: 'error', message: 'Producto no encontrado' });
    }

    const { data, error } = sanitizeSupermarketPayload(payload, { partial });
    if (error) {
      return res.status(400).json({ status: 'error', message: error });
    }

    console.log('[SUPERMARKET] sanitized update', { id: trimmedId, partial, updates: data });

    if (!Object.keys(data).length) {
      return res.status(400).json({ status: 'error', message: 'No hay cambios para aplicar' });
    }

    const updates = { ...data, updatedAt: nowIso(), id: trimmedId };
    await docRef.set(updates, { merge: true });

    const updatedSnap = await docRef.get();
    const updatedItem = mapSupermarketDoc(updatedSnap);

    const itemName = updatedItem.name || 'Producto';
    const details = [];
    if (updatedItem.quantity) {
      details.push(`${updatedItem.quantity} ${updatedItem.unit || ''}`.trim());
    }
    if (updatedItem.category) {
      details.push(`Categoría ${updatedItem.category}`);
    }
    if (updatedItem.store) {
      details.push(`Tienda ${updatedItem.store}`);
    }

    await notifyEntityUpdated({
      title: `Lista actualizada: ${itemName}`,
      body: details.join(' | ') || (updatedItem.notes ? truncateText(updatedItem.notes, 90) : ''),
      data: {
        entityType: 'supermarket',
        itemId: trimmedId,
        name: itemName,
        checked: !!updatedItem.checked,
        category: updatedItem.category || null,
      },
    });

    return res.status(200).json({ status: 'success', data: updatedItem });
  } catch (error) {
    console.error('[SUPERMARKET] update error', error);
    return res.status(500).json({ status: 'error', message: 'Error al actualizar el producto', error: error.message });
  }
}

router.get('/supermarket', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const collectionRef = database.collection(SUPERMARKET_COLLECTION);
    const snapshot = await collectionRef.get();
    const items = snapshot.docs.map(mapSupermarketDoc);
    sortSupermarketItems(items);

    const stats = computeSupermarketStats(items);

    const checkedFilter = toTrimmedString(req.query && req.query.checked ? req.query.checked : '');
    const categoryFilter = toTrimmedString(req.query && req.query.category ? req.query.category : '').toLowerCase();
    const searchFilter = toTrimmedString(req.query && req.query.search ? req.query.search : '').toLowerCase();

    const filtered = items.filter(item => {
      if (checkedFilter === 'true' && !item.checked) return false;
      if (checkedFilter === 'false' && item.checked) return false;
      if (categoryFilter && (typeof item.category !== 'string' || item.category.toLowerCase() !== categoryFilter)) return false;
      if (searchFilter) {
        const haystack = [item.name, item.notes, item.category, item.store]
          .filter(value => typeof value === 'string')
          .map(value => value.toLowerCase())
          .join(' ');
        if (!haystack.includes(searchFilter)) return false;
      }
      return true;
    });

    return res.status(200).json({
      status: 'success',
      data: filtered,
      meta: {
        total: items.length,
        filtered: filtered.length,
        stats,
      },
    });
    return res.status(500).json({ status: 'error', message: 'Error al listar la lista de super', error: error.message });
  }
  catch {}
});

router.post('/supermarket', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const payload = req.body && req.body.data ? req.body.data : req.body;
    console.log('[SUPERMARKET] create request', { payload });
    const { data, error } = sanitizeSupermarketPayload(payload, { partial: false });
    if (error) {
      return res.status(400).json({ status: 'error', message: error });
    }

    const collectionRef = database.collection(SUPERMARKET_COLLECTION);
    const requestedId = payload && Object.prototype.hasOwnProperty.call(payload, 'id') ? toTrimmedString(payload.id) : '';
    const docRef = requestedId ? collectionRef.doc(requestedId) : collectionRef.doc();
    console.log('[SUPERMARKET] create sanitized', { requestedId, docId: docRef.id, data });

    const now = nowIso();
    const itemData = {
      ...SUPERMARKET_DEFAULTS,
      ...data,
      id: docRef.id,
      createdAt: now,
      updatedAt: now,
    };
    if (!Array.isArray(itemData.tags)) itemData.tags = [];

    await docRef.set(itemData);
    return res.status(201).json({ status: 'success', data: itemData });
  } catch (error) {
    console.error('[SUPERMARKET] create error', error);
    return res.status(500).json({ status: 'error', message: 'Error al crear el producto', error: error.message });
  }
});

router.put('/supermarket/:id', (req, res) => updateSupermarketItem(req, res, { partial: false }));
router.patch('/supermarket/:id', (req, res) => updateSupermarketItem(req, res, { partial: true }));

router.delete('/supermarket/:id', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const { id } = req.params;
    const trimmedId = typeof id === 'string' ? id.trim() : String(id || '').trim();
    if (!trimmedId) {
      return res.status(400).json({ status: 'error', message: 'Identificador de producto invalido' });
    }

    const docRef = database.collection(SUPERMARKET_COLLECTION).doc(trimmedId);
    const snapshot = await docRef.get();
    if (!snapshot.exists) {
      return res.status(404).json({ status: 'error', message: 'Producto no encontrado' });
    }

    await docRef.delete();
    return res.status(200).json({ status: 'success', message: 'Producto eliminado' });
  } catch (error) {
    console.error('[SUPERMARKET] delete error', error);
    return res.status(500).json({ status: 'error', message: 'Error al eliminar el producto', error: error.message });
  }
});

// =========================
// Debts (Firestorm ledger)
// =========================

const DEBT_ORDER_FIELDS = new Set(['date', 'createdAt', 'updatedAt', 'amount']);

const exportDebtDocument = (doc) => {
  const data = doc.data() || {};
  const title =
    typeof data.title === 'string'
      ? data.title
      : typeof data.name === 'string'
        ? data.name
        : '';
  const amount = normalizeDebtAmount(data.amount ?? data.monto ?? data.value ?? 0);
  return {
    id: doc.id,
    title,
    amount: Number.isNaN(amount) ? 0 : amount,
    type: normalizeDebtType(data.type),
    date: normalizeDebtDate(data.date ?? data.fecha ?? data.createdAt),
    notes: typeof data.notes === 'string' ? data.notes : null,
    createdAt: toIsoDateOrNull(data.createdAt),
    updatedAt: toIsoDateOrNull(data.updatedAt),
  };
};

router.get('/debts', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const orderQuery = req.query && typeof req.query.order === 'string' ? req.query.order : '';
    const { field, direction } = parseOrderSpec(orderQuery, DEBT_ORDER_FIELDS, 'date', 'desc');
    let lastError;

    for (const collectionName of DEBTS_COLLECTION_CANDIDATES) {
      try {
        const collectionRef = database.collection(collectionName);
        let query = collectionRef;
        try {
          query = query.orderBy(field, direction);
        } catch (orderError) {
          const code = orderError && (orderError.code || orderError.codeNumber);
          const isPrecondition = code === 9 || code === 'failed-precondition';
          if (isPrecondition) {
            query = collectionRef;
          } else {
            throw orderError;
          }
        }
        const snapshot = await query.get();
        const items = snapshot.docs.map(exportDebtDocument);
        return res.status(200).json({
          status: 'success',
          data: sortDebtEntries(items),
        });
      } catch (error) {
        lastError = error;
        console.warn('[DEBTS] read error', { collection: collectionName, error: error.message });
        continue;
      }
    }

    if (lastError) {
      throw lastError;
    }

    return res.status(200).json({ status: 'success', data: [] });
  } catch (error) {
    console.error('[DEBTS] list error', error);
    return res.status(500).json({ status: 'error', message: 'Error al obtener las deudas', error: error.message });
  }
});

router.post('/debts', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const payload = req.body && req.body.data ? req.body.data : req.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ status: 'error', message: 'El cuerpo debe ser un objeto' });
    }

    const rawTitle =
      typeof payload.title === 'string'
        ? payload.title
        : typeof payload.name === 'string'
          ? payload.name
          : '';
    const title = rawTitle.trim();
    if (!title) {
      return res.status(400).json({ status: 'error', message: 'El campo "title" es requerido' });
    }

    const amount = normalizeDebtAmount(payload.amount ?? payload.monto ?? payload.value);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ status: 'error', message: 'El monto debe ser un numero mayor que cero' });
    }

    const type = normalizeDebtType(payload.type);
    const isoDate = normalizeDebtDate(payload.date ?? payload.fecha ?? payload.createdAt);
    const now = nowIso();
    const entryData = {
      title,
      amount,
      type,
      date: isoDate,
      createdAt: now,
      updatedAt: now,
    };
    if (typeof payload.notes === 'string' && payload.notes.trim().length) {
      entryData.notes = payload.notes.trim();
    } else if (typeof payload.description === 'string' && payload.description.trim().length) {
      entryData.notes = payload.description.trim();
    }

    const collectionRef = database.collection(DEBTS_COLLECTION);
    const docRef = await collectionRef.add(entryData);
    const snapshot = await docRef.get();
    const created = exportDebtDocument(snapshot);

    try {
      await notifyEntityCreated({
        title: 'Nuevo movimiento de deuda',
        body: `${created.type === 'deuda' ? 'Se registro una deuda' : 'Se registro un abono'} por ${created.title}`,
        data: { entity: 'debt', id: docRef.id, amount: created.amount, type: created.type },
      });
    } catch (notifyError) {
      console.warn('[DEBTS] notify error', notifyError);
    }

    return res.status(201).json({ status: 'success', data: created });
  } catch (error) {
    console.error('[DEBTS] create error', error);
    return res.status(500).json({ status: 'error', message: 'Error al registrar la deuda', error: error.message });
  }
});

// =========================
// Firestore legacy routes (general CRUD)
// =========================

router.get('/GetPendientesFS', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;

    const snap = await database.collection(FS_COLLECTION).get();
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.status(200).json({ status: 'success', data: items });
  } catch (error) {
      return res.status(500).json({ status: 'error', message: 'Error al listar pendientes', error: error.message });
  }
});

router.get('/GetPendientesFS_ID/:id', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;
    const { id } = req.params;
    const ref = database.collection(FS_COLLECTION).doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ status: 'error', message: 'No encontrado' });
    return res.status(200).json({ status: 'success', data: { id: snap.id, ...snap.data() } });
  } catch (error) {
      return res.status(500).json({ status: 'error', message: 'Error al obtener el pendiente', error: error.message });
  }
});

router.post('/SavePendientesFS', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;
    const payload = req.body && req.body.data ? req.body.data : req.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ status: 'error', message: 'El cuerpo debe ser un objeto' });
    }
    const ref = await database.collection(FS_COLLECTION).add(payload);
    return res.status(201).json({ status: 'success', id: ref.id });
  } catch (error) {
      return res.status(500).json({ status: 'error', message: 'Error al crear el pendiente', error: error.message });
  }
});

router.put('/EditPendientesFS_ID/:id', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;
    const { id } = req.params;
    const payload = req.body && req.body.data ? req.body.data : req.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ status: 'error', message: 'El cuerpo debe ser un objeto' });
    }
    const ref = database.collection(FS_COLLECTION).doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ status: 'error', message: 'No encontrado' });
    await ref.set(payload, { merge: true });
    return res.status(200).json({ status: 'success', message: 'Actualizado' });
  } catch (error) {
      return res.status(500).json({ status: 'error', message: 'Error al actualizar', error: error.message });
  }
});

router.delete('/DeletePendientesFS_ID/:id', async (req, res) => {
  try {
    const database = ensureDb(res);
    if (!database) return;
    const { id } = req.params;
    const ref = database.collection(FS_COLLECTION).doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ status: 'error', message: 'No encontrado' });
    await ref.delete();
    return res.status(200).json({ status: 'success', message: 'Eliminado' });
  } catch (error) {
      return res.status(500).json({ status: 'error', message: 'Error al eliminar', error: error.message });
  }
});

router.get('/_debugFS', (req, res) => {
  const databaseReady = !!getDb();
  const projectId = process.env.FB_PROJECT_ID ? 'set' : 'missing';
  const clientEmail = process.env.FB_CLIENT_EMAIL ? 'set' : 'missing';
  const hasKey = process.env.FB_PRIVATE_KEY ? 'set' : 'missing';
  const err = _fsInitErr ? _fsInitErr.message : undefined;
  return res.status(200).json({ dbReady: databaseReady, projectId, clientEmail, privateKey: hasKey, error: err, taskStatuses: TASK_STATUSES });
});

module.exports = router;




