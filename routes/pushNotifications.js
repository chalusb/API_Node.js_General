'use strict';

const express = require('express');
const axios = require('axios');

const { admin, db } = require('../core/firebase');

const router = express.Router();

const PUSH_TOKENS_COLLECTION = process.env.FS_PUSH_TOKENS_COLLECTION || 'PushTokens';
const CHAT_MESSAGES_COLLECTION = process.env.FS_CHAT_MESSAGES_COLLECTION || 'ChatMessages';
const CHAT_DEFAULT_LIMIT = 50;
const CHAT_MAX_LIMIT = 200;
const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
const RAW_EXPO_ACCESS_TOKEN = process.env.EXPO_ACCESS_TOKEN || process.env.EXPO_PUSH_ACCESS_TOKEN;
const EXPO_MAX_BATCH = 100;
const FCM_MAX_BATCH = 500;

const chunkArray = (items, size) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

const isExpoToken = (token) => typeof token === 'string' && token.startsWith('ExponentPushToken[');

const fieldTimestamp = () => admin.firestore.FieldValue.serverTimestamp();

const toDocId = (token) => Buffer.from(token).toString('base64url');

const normalizeString = (value) => (typeof value === 'string' ? value.trim() : '');
const normalizeDisplayName = (value) => {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  return normalized.slice(0, 80);
};
const EXPO_ACCESS_TOKEN = normalizeString(RAW_EXPO_ACCESS_TOKEN);
if (!EXPO_ACCESS_TOKEN) {
  console.warn('[NOTIFICATIONS] Missing EXPO_ACCESS_TOKEN env; Expo pushes may fail with InvalidCredentials');
}

const serializeDataPayload = (data) => {
  if (!data || typeof data !== 'object') return undefined;
  return Object.fromEntries(
    Object.entries(data)
      .filter(([key]) => typeof key === 'string')
      .map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)])
  );
};

const timestampToIso = (value) => {
  if (!value) return null;
  if (typeof value.toDate === 'function') {
    try {
      return value.toDate().toISOString();
    } catch (error) {
      console.warn('[NOTIFICATIONS] timestamp toDate error', error);
      return null;
    }
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string') return value;
  return null;
};

const touchToken = async (token) => {
  const normalized = normalizeString(token);
  if (!normalized) return;
  const docId = toDocId(normalized);
  const docRef = db.collection(PUSH_TOKENS_COLLECTION).doc(docId);
  await docRef.set(
    {
      active: true,
      lastUsedAt: fieldTimestamp(),
      updatedAt: fieldTimestamp(),
    },
    { merge: true }
  );
};

const markTokensInactive = async (tokens) => {
  if (!Array.isArray(tokens) || !tokens.length) return;
  const batch = db.batch();
  const now = fieldTimestamp();
  let hasUpdates = false;
  tokens.forEach((token) => {
    const normalized = normalizeString(token);
    if (!normalized) return;
    const docId = toDocId(normalized);
    const docRef = db.collection(PUSH_TOKENS_COLLECTION).doc(docId);
    batch.set(
      docRef,
      {
        active: false,
        deactivatedAt: now,
        updatedAt: now,
      },
      { merge: true }
    );
    hasUpdates = true;
  });
  if (hasUpdates) {
    await batch.commit();
  }
};

const dedupeDeviceRecords = async ({ deviceId, currentDocId }) => {
  const normalizedDeviceId = normalizeString(deviceId);
  if (!normalizedDeviceId) return;

  const snapshot = await db.collection(PUSH_TOKENS_COLLECTION).where('deviceId', '==', normalizedDeviceId).get();
  if (snapshot.empty) return;

  const batch = db.batch();
  const now = fieldTimestamp();
  let hasUpdates = false;

  snapshot.forEach((doc) => {
    if (doc.id === currentDocId) return;
    batch.set(
      doc.ref,
      {
        active: false,
        duplicateOf: currentDocId,
        updatedAt: now,
        deactivatedAt: now,
      },
      { merge: true }
    );
    hasUpdates = true;
  });

  if (hasUpdates) {
    await batch.commit();
  }
};

const upsertToken = async ({ token, deviceId, userId, platform, appVersion, pushProvider, displayName }) => {
  const normalizedToken = normalizeString(token);
  if (!normalizedToken) {
    const error = new Error('Token de notificacion invalido');
    error.status = 400;
    throw error;
  }

  const tokenType = pushProvider || (isExpoToken(normalizedToken) ? 'expo' : 'fcm');
  const docId = toDocId(normalizedToken);
  const docRef = db.collection(PUSH_TOKENS_COLLECTION).doc(docId);
  const snapshot = await docRef.get();
  const isNew = !snapshot.exists;

  const normalizedDeviceId = normalizeString(deviceId);
  const normalizedUserId = normalizeString(userId);
  const normalizedPlatform = normalizeString(platform) || null;
  const normalizedAppVersion = normalizeString(appVersion) || null;
  const normalizedDisplayName = displayName === undefined ? undefined : normalizeDisplayName(displayName);

  const now = fieldTimestamp();
  const payload = {
    token: normalizedToken,
    tokenType,
    platform: normalizedPlatform,
    deviceId: normalizedDeviceId || null,
    userId: normalizedUserId || null,
    appVersion: normalizedAppVersion,
    active: true,
    updatedAt: now,
    lastUsedAt: now,
  };

  if (normalizedDisplayName !== undefined) {
    payload.displayName = normalizedDisplayName;
  } else if (!isNew && snapshot.data()?.displayName) {
    payload.displayName = snapshot.data().displayName;
  } else if (isNew && normalizedDeviceId) {
    payload.displayName = normalizeDisplayName(normalizedDeviceId);
  }

  if (isNew) {
    payload.createdAt = now;
  }

  await docRef.set(payload, { merge: true });
  await dedupeDeviceRecords({ deviceId: normalizedDeviceId, currentDocId: docId });

  const storedSnapshot = await docRef.get();
  const storedData = storedSnapshot.data() || {};

  return {
    token: normalizedToken,
    tokenType,
    isNew,
    displayName: storedData.displayName || null,
    docId,
  };
};

const sendExpoNotifications = async (tokens, payload) => {
  const invalidTokens = [];
  const invalidDetails = [];
  let delivered = 0;

  const messages = tokens.map((token) => ({
    to: token,
    sound: payload.sound || 'default',
    title: payload.title,
    body: payload.body,
    data: payload.data || {},
  }));

  const chunks = chunkArray(messages, EXPO_MAX_BATCH);

  for (const chunk of chunks) {
    try {
      const headers = {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      };
      if (EXPO_ACCESS_TOKEN) {
        headers.Authorization = `Bearer ${EXPO_ACCESS_TOKEN}`;
      }
      const response = await axios.post(EXPO_PUSH_ENDPOINT, chunk, { headers });
      console.log('[NOTIFICATIONS] expo send chunk', {
        attempted: chunk.length,
        status: response.status,
        data: response.data,
      });

      const tickets = Array.isArray(response.data?.data) ? response.data.data : response.data;
      if (!Array.isArray(tickets)) {
        continue;
      }

      tickets.forEach((ticket, index) => {
        if (ticket?.status === 'ok') {
          delivered += 1;
          return;
        }

        const reason = ticket?.details?.error || ticket?.message || 'unknown';
        const tokenValue = chunk[index].to;
        invalidDetails.push({
          token: tokenValue,
          status: ticket?.status || 'error',
          message: ticket?.message,
          reason,
          details: ticket?.details,
        });
        if (['DeviceNotRegistered', 'NotRegistered', 'MessageTooBig', 'InvalidCredentials'].includes(reason)) {
          invalidTokens.push(tokenValue);
        }
      });
    } catch (error) {
      console.error('[NOTIFICATIONS] expo send error', error?.response?.data || error?.message || error);
      const fallbackTokens = chunk.map((message) => message.to);
      invalidTokens.push(...fallbackTokens);
      fallbackTokens.forEach((token) => {
        invalidDetails.push({
          token,
          status: 'error',
          message: error?.message || 'chunk failure',
          reason: 'ChunkSendError',
          details: error?.response?.data,
        });
      });
    }
  }

  return {
    invalidTokens,
    invalidDetails,
    stats: {
      provider: 'expo',
      attempted: tokens.length,
      delivered,
    },
  };
};

const sendFcmNotifications = async (tokens, payload) => {
  const invalidTokens = [];
  let delivered = 0;

  const dataPayload = serializeDataPayload(payload.data);
  const chunks = chunkArray(tokens, FCM_MAX_BATCH);

  for (const chunk of chunks) {
    try {
      const response = await admin.messaging().sendEachForMulticast({
        tokens: chunk,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: dataPayload,
      });

      response?.responses?.forEach((result, index) => {
        if (result.success) {
          delivered += 1;
        } else {
          const errorCode = result.error?.code;
          if (
            errorCode === 'messaging/invalid-registration-token' ||
            errorCode === 'messaging/registration-token-not-registered'
          ) {
            invalidTokens.push(chunk[index]);
          }
        }
      });
    } catch (error) {
      console.error('[NOTIFICATIONS] fcm send error', error?.message || error);
      invalidTokens.push(...chunk);
    }
  }

  return {
    invalidTokens,
    stats: {
      provider: 'fcm',
      attempted: tokens.length,
      delivered,
    },
  };
};

const buildExclusionSet = ({ excludeTokens, senderToken }) => {
  const exclusionSet = new Set();
  const add = (value) => {
    const normalized = normalizeString(value);
    if (normalized) exclusionSet.add(normalized);
  };
  if (Array.isArray(excludeTokens)) excludeTokens.forEach(add);
  if (senderToken) add(senderToken);
  return exclusionSet;
};

const resolveTargetTokens = async ({ explicitTokens, exclusionSet }) => {
  let targetTokens = Array.isArray(explicitTokens) ? explicitTokens : null;

  if (!targetTokens || !targetTokens.length) {
    const snapshot = await db.collection(PUSH_TOKENS_COLLECTION).where('active', '==', true).get();
    targetTokens = snapshot.docs.map((doc) => doc.data()?.token).filter(Boolean);
    if (!targetTokens.length) {
      const expoSnap = await db.collection(PUSH_TOKENS_COLLECTION).where('tokenType', '==', 'expo').get();
      if (!expoSnap.empty) {
        const latestDoc = expoSnap.docs.reduce((latest, doc) => {
          const data = doc.data() || {};
          const ts = data.updatedAt?.toMillis?.() || data.updatedAt || 0;
          if (!latest || ts > latest.ts) {
            return { ts, token: data.token };
          }
          return latest;
        }, null);
        if (latestDoc?.token) {
          targetTokens = [latestDoc.token];
        }
      }
    }
  }

  const sanitizedTokens = Array.from(
    new Set(
      (targetTokens || [])
        .map(normalizeString)
        .filter(Boolean)
        .filter((token) => !exclusionSet.has(token))
    )
  );

  return sanitizedTokens;
};

const deliverNotification = async ({ title, body, data, sound, explicitTokens, excludeTokens, senderToken }) => {
  const normalizedTitle = normalizeString(title);
  const normalizedBody = normalizeString(body);
  if (!normalizedTitle || !normalizedBody) {
    const error = new Error('Se requieren titulo y cuerpo para la notificacion');
    error.status = 400;
    throw error;
  }

  const exclusionSet = buildExclusionSet({ excludeTokens, senderToken });
  const sanitizedTokens = await resolveTargetTokens({ explicitTokens, exclusionSet });

  if (!sanitizedTokens.length) {
    return {
      ok: true,
      message: 'No hay destinatarios para la notificacion',
      stats: [{ provider: 'none', attempted: 0, delivered: 0 }],
      totalTargets: 0,
      invalidTokens: 0,
      delivered: 0,
      deliveredTokens: [],
    };
  }

  const expoTokens = sanitizedTokens.filter(isExpoToken);
  const fcmTokens = sanitizedTokens.filter((token) => !isExpoToken(token));

  const payload = { title: normalizedTitle, body: normalizedBody, data, sound };
  const invalidTokens = [];
  const providersStats = [];
  console.log('[NOTIFICATIONS] deliver', {
    title: normalizedTitle,
    totalTargets: sanitizedTokens.length,
    expoTokens: expoTokens.length,
    fcmTokens: fcmTokens.length,
    excluded: exclusionSet.size,
  });

  if (expoTokens.length) {
    const result = await sendExpoNotifications(expoTokens, payload);
    invalidTokens.push(...result.invalidTokens);
    if (result.invalidDetails && result.invalidDetails.length) {
      result.invalidDetails.forEach((detail) => {
        console.warn('[NOTIFICATIONS] expo invalid token', detail);
      });
    }
    providersStats.push(result.stats);
  }

  if (fcmTokens.length) {
    const result = await sendFcmNotifications(fcmTokens, payload);
    invalidTokens.push(...result.invalidTokens);
    providersStats.push(result.stats);
  }

  const invalidSet = new Set(invalidTokens);
  const deliveredTokens = sanitizedTokens.filter((token) => !invalidSet.has(token));

  await Promise.all(deliveredTokens.map((token) => touchToken(token)));
  await markTokensInactive(invalidTokens);

  const responsePayload = {
    ok: true,
    stats: providersStats,
    totalTargets: sanitizedTokens.length,
    invalidTokens: invalidTokens.length,
    delivered: deliveredTokens.length,
    deliveredTokens,
  };
  console.log('[NOTIFICATIONS] deliver result', responsePayload);
  return responsePayload;
};

router.post('/notifications/register', async (req, res) => {
  try {
    const { token, deviceId, userId, platform, appVersion, pushProvider, displayName } = req.body || {};

    const result = await upsertToken({
      token,
      deviceId,
      userId,
      platform,
      appVersion,
      pushProvider,
      displayName,
    });

    res.status(result.isNew ? 201 : 200).json({
      ok: true,
      token: result.token,
      tokenType: result.tokenType,
      isNew: result.isNew,
      displayName: result.displayName,
    });
  } catch (error) {
    const status = error.status || 500;
    console.error('[NOTIFICATIONS] register error', error);
    res.status(status).json({
      ok: false,
      message: error.message || 'No se pudo registrar el token',
    });
  }
});

router.get('/notifications/devices', async (req, res) => {
  try {
    const snapshot = await db.collection(PUSH_TOKENS_COLLECTION).get();
    const devicesRaw = snapshot.docs
      .map((doc) => {
        const data = doc.data() || {};
        const token = normalizeString(data.token);
        if (!token) return null;
        return {
          id: doc.id,
          token,
          tokenType: data.tokenType || null,
          platform: data.platform || null,
          deviceId: data.deviceId || null,
          userId: data.userId || null,
          appVersion: data.appVersion || null,
          displayName: data.displayName || null,
          duplicateOf: data.duplicateOf || null,
          active: data.active === undefined ? true : Boolean(data.active),
          createdAt: timestampToIso(data.createdAt),
          updatedAt: timestampToIso(data.updatedAt),
          lastUsedAt: timestampToIso(data.lastUsedAt),
          deactivatedAt: timestampToIso(data.deactivatedAt),
        };
      })
      .filter(Boolean);

    const uniqueByDevice = new Map();
    devicesRaw.forEach((device) => {
      const key = device.deviceId || device.token;
      const existing = uniqueByDevice.get(key);
      if (!existing) {
        uniqueByDevice.set(key, device);
        return;
      }

      const existingActive = existing.active !== false;
      const currentActive = device.active !== false;
      if (currentActive && !existingActive) {
        uniqueByDevice.set(key, device);
        return;
      }

      const existingUpdated = existing.updatedAt || existing.lastUsedAt || '';
      const currentUpdated = device.updatedAt || device.lastUsedAt || '';
      if (currentUpdated > existingUpdated) {
        uniqueByDevice.set(key, device);
      }
    });

    const devices = Array.from(uniqueByDevice.values())
      .filter((device) => device.active !== false)
      .sort((a, b) => {
        const aTime = a.updatedAt || a.lastUsedAt || '';
        const bTime = b.updatedAt || b.lastUsedAt || '';
        if (aTime === bTime) return 0;
        return aTime > bTime ? -1 : 1;
      });

    res.status(200).json({ ok: true, data: devices });
  } catch (error) {
    console.error('[NOTIFICATIONS] list devices error', error);
    res.status(500).json({
      ok: false,
      message: 'No se pudo obtener la lista de dispositivos',
    });
  }
});

router.patch('/notifications/devices/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!normalizeString(id)) {
      return res.status(400).json({
        ok: false,
        message: 'Identificador de dispositivo invalido',
      });
    }

    const docRef = db.collection(PUSH_TOKENS_COLLECTION).doc(id);
    const snapshot = await docRef.get();
    if (!snapshot.exists) {
      return res.status(404).json({
        ok: false,
        message: 'Dispositivo no encontrado',
      });
    }

    const { displayName } = req.body || {};
    const updates = { updatedAt: fieldTimestamp() };
    if (displayName !== undefined) {
      updates.displayName = normalizeDisplayName(displayName);
    }

    await docRef.set(updates, { merge: true });
    const stored = await docRef.get();
    const data = stored.data() || {};

    res.status(200).json({
      ok: true,
      data: {
        id: stored.id,
        token: data.token,
        tokenType: data.tokenType || null,
        platform: data.platform || null,
        deviceId: data.deviceId || null,
        userId: data.userId || null,
        appVersion: data.appVersion || null,
        displayName: data.displayName || null,
        active: data.active === undefined ? true : Boolean(data.active),
        updatedAt: timestampToIso(data.updatedAt),
        lastUsedAt: timestampToIso(data.lastUsedAt),
      },
    });
  } catch (error) {
    console.error('[NOTIFICATIONS] update device error', error);
    const status = error.status || 500;
    res.status(status).json({
      ok: false,
      message: error.message || 'No se pudo actualizar el dispositivo',
    });
  }
});

router.get('/notifications/messages', async (req, res) => {
  try {
    const limitParam = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), CHAT_MAX_LIMIT) : CHAT_DEFAULT_LIMIT;
    const snapshot = await db.collection(CHAT_MESSAGES_COLLECTION).orderBy('createdAt', 'desc').limit(limit).get();

    const messages = snapshot.docs.map((doc) => {
      const data = doc.data() || {};
      return {
        id: doc.id,
        title: data.title || null,
        message: data.message || '',
        senderToken: data.senderToken || null,
        senderDeviceId: data.senderDeviceId || null,
        senderDisplayName: data.senderDisplayName || null,
        senderPlatform: data.senderPlatform || null,
        appVersion: data.appVersion || null,
        recipientTokens: Array.isArray(data.recipientTokens) ? data.recipientTokens : [],
        data: data.data || null,
        deliveredCount: data.deliveredCount || 0,
        invalidCount: data.invalidCount || 0,
        createdAt: timestampToIso(data.createdAt),
        updatedAt: timestampToIso(data.updatedAt),
        deliveredAt: timestampToIso(data.deliveredAt),
      };
    });

    res.status(200).json({
      ok: true,
      data: messages.reverse(),
    });
  } catch (error) {
    console.error('[NOTIFICATIONS] get messages error', error);
    res.status(500).json({
      ok: false,
      message: 'No se pudo obtener el historial de mensajes',
    });
  }
});

router.post('/notifications/messages', async (req, res) => {
  try {
    const { message, title, senderToken, recipientTokens, data, sound } = req.body || {};

    const sanitizedMessage = normalizeString(message);
    if (!sanitizedMessage) {
      return res.status(400).json({
        ok: false,
        message: 'El mensaje es requerido',
      });
    }

    const normalizedSenderToken = normalizeString(senderToken);
    if (!normalizedSenderToken) {
      return res.status(400).json({
        ok: false,
        message: 'Se requiere el token del remitente',
      });
    }

    const normalizedTitle = normalizeString(title) || 'Mensaje nuevo';
    const normalizedData = data && typeof data === 'object' ? data : null;
    const normalizedRecipients = Array.isArray(recipientTokens)
      ? Array.from(new Set(recipientTokens.map(normalizeString).filter(Boolean)))
      : null;

    const senderDoc = await db.collection(PUSH_TOKENS_COLLECTION).doc(toDocId(normalizedSenderToken)).get();
    const senderInfo = senderDoc.exists ? senderDoc.data() || {} : {};

    const now = fieldTimestamp();
    const docRef = await db.collection(CHAT_MESSAGES_COLLECTION).add({
      title: normalizedTitle,
      message: sanitizedMessage,
      senderToken: normalizedSenderToken,
      senderDeviceId: senderInfo.deviceId || null,
      senderDisplayName: senderInfo.displayName || null,
      senderPlatform: senderInfo.platform || null,
      appVersion: senderInfo.appVersion || null,
      recipientTokens: normalizedRecipients,
      data: normalizedData,
      createdAt: now,
      updatedAt: now,
    });

    const delivery = await deliverNotification({
      title: normalizedTitle,
      body: sanitizedMessage,
      data: {
        ...(normalizedData || {}),
        chat: 'true',
        chatMessageId: docRef.id,
        senderDeviceId: senderInfo.deviceId || null,
        senderDisplayName: senderInfo.displayName || null,
      },
      sound: sound || 'notifications.wav',
      explicitTokens: normalizedRecipients,
      excludeTokens: [],
      senderToken: normalizedSenderToken,
    });

    await docRef.set(
      {
        deliveredCount: delivery.delivered || 0,
        invalidCount: delivery.invalidTokens || 0,
        deliveredAt: delivery.delivered ? fieldTimestamp() : null,
        updatedAt: fieldTimestamp(),
      },
      { merge: true }
    );

    const snapshot = await docRef.get();
    const stored = snapshot.data() || {};

    res.status(201).json({
      ok: true,
      data: {
        id: docRef.id,
        title: stored.title || normalizedTitle,
        message: stored.message || sanitizedMessage,
        senderToken: stored.senderToken || normalizedSenderToken,
        senderDeviceId: stored.senderDeviceId || senderInfo.deviceId || null,
        senderDisplayName: stored.senderDisplayName || senderInfo.displayName || null,
        senderPlatform: stored.senderPlatform || senderInfo.platform || null,
        appVersion: stored.appVersion || senderInfo.appVersion || null,
        recipientTokens: Array.isArray(stored.recipientTokens) ? stored.recipientTokens : [],
        data: stored.data || normalizedData,
        deliveredCount: stored.deliveredCount || delivery.delivered || 0,
        invalidCount: stored.invalidCount || delivery.invalidTokens || 0,
        createdAt: timestampToIso(stored.createdAt),
        updatedAt: timestampToIso(stored.updatedAt),
        deliveredAt: timestampToIso(stored.deliveredAt),
        delivery,
      },
    });
  } catch (error) {
    console.error('[NOTIFICATIONS] create message error', error);
    const status = error.status || 500;
    res.status(status).json({
      ok: false,
      message: error.message || 'No se pudo enviar el mensaje',
    });
  }
});

router.post('/notifications/broadcast', async (req, res) => {
  try {
    const { title, body, data, sound, excludeTokens, senderToken, tokens: explicitTokens } = req.body || {};

    const result = await deliverNotification({
      title,
      body,
      data,
      sound,
      excludeTokens,
      explicitTokens,
      senderToken,
    });

    res.status(200).json(result);
  } catch (error) {
    const status = error.status || 500;
    console.error('[NOTIFICATIONS] broadcast error', error);
    res.status(status).json({
      ok: false,
      message: error.message || 'No se pudo enviar la notificacion',
    });
  }
});

module.exports = router;
module.exports.deliverNotification = deliverNotification;
