"use strict";
// Back de la página de Comunidad Capital (capital.paginascss.com).
// Se monta en app.js como /PaginaCapital
//
// Variables de entorno:
//   DATABASE_URL                  Postgres (Railway)
//   CAPITAL_ADMIN_PASSWORD_HASH   hash bcrypt de la contraseña del admin
//                                 (generar con: node scripts/capital-hash.js "contraseña")
//   CAPITAL_JWT_SECRET            secreto largo y aleatorio para firmar los tokens
const express = require('express');
const axios = require('axios');
const bcrypt = require('bcrypt');
const jwt = require('jwt-simple');
const db = require('./../core/capital/db');
const router = express.Router();

const iniciado = new Date();
const TOKEN_HORAS = 12;

// ───────────────────────── utilidades ─────────────────────────

const ok = (res, data, code = 200) => res.status(code).json({ status: 'success', data });
const fail = (res, code, message, extra) => res.status(code).json({ status: 'error', message, ...extra });

// Extrae el id de un link de YouTube (watch, youtu.be, shorts, live, embed) o acepta el id directo.
function youtubeId(input) {
    const s = String(input || '').trim();
    if (/^[\w-]{11}$/.test(s)) return s;
    try {
        const u = new URL(s);
        const host = u.hostname.replace(/^www\.|^m\./, '');
        if (host === 'youtu.be') return /^[\w-]{11}$/.test(u.pathname.slice(1, 12)) ? u.pathname.slice(1, 12) : null;
        if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'music.youtube.com') {
            const v = u.searchParams.get('v');
            if (v && /^[\w-]{11}$/.test(v)) return v;
            const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([\w-]{11})/);
            if (m) return m[1];
        }
    } catch (e) { /* no es URL */ }
    return null;
}

// Convierte una fila de la base al formato que usa la página.
function toEpisodio(r) {
    const fecha = r.fecha instanceof Date ? r.fecha.toISOString().slice(0, 10) : (r.fecha || '');
    return {
        id: r.id,
        youtubeId: r.youtube_id,
        titulo: r.titulo,
        serie: r.serie,
        numero: r.numero,
        fecha,
        duracion: r.duracion,
        descripcion: r.descripcion,
        miniatura: r.miniatura || `https://i.ytimg.com/vi/${r.youtube_id}/hqdefault.jpg`,
        url: `https://www.youtube.com/watch?v=${r.youtube_id}`,
        embedUrl: `https://www.youtube-nocookie.com/embed/${r.youtube_id}`,
        publicado: r.publicado,
        destacado: r.destacado,
        creado: r.creado,
        actualizado: r.actualizado,
    };
}

// Valida y normaliza el cuerpo de un episodio. parcial=true para ediciones.
function validarEpisodio(body, parcial = false) {
    const errores = {};
    const out = {};
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

    if (!parcial || has('youtube')) {
        const id = youtubeId(body.youtube);
        if (!id) errores.youtube = 'Pega un link válido de YouTube.';
        else out.youtube_id = id;
    }
    if (!parcial || has('titulo')) {
        const t = String(body.titulo || '').trim();
        if (!t) errores.titulo = 'El título es obligatorio.';
        else if (t.length > 200) errores.titulo = 'Máximo 200 caracteres.';
        else out.titulo = t;
    }
    if (has('serie')) {
        const v = String(body.serie || '').trim();
        if (v.length > 120) errores.serie = 'Máximo 120 caracteres.'; else out.serie = v;
    }
    if (has('numero')) {
        if (body.numero === '' || body.numero === null) out.numero = null;
        else {
            const n = Number(body.numero);
            if (!Number.isInteger(n) || n < 0 || n > 9999) errores.numero = 'Debe ser un número entero.';
            else out.numero = n;
        }
    }
    if (has('fecha')) {
        const f = String(body.fecha || '').trim();
        if (!f) out.fecha = null;
        else if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || isNaN(Date.parse(f))) errores.fecha = 'Usa el formato AAAA-MM-DD.';
        else out.fecha = f;
    }
    if (has('duracion')) {
        const d = String(body.duracion || '').trim();
        if (d.length > 20) errores.duracion = 'Máximo 20 caracteres.'; else out.duracion = d;
    }
    if (has('descripcion')) {
        const d = String(body.descripcion || '').trim();
        if (d.length > 2000) errores.descripcion = 'Máximo 2000 caracteres.'; else out.descripcion = d;
    }
    if (has('miniatura')) {
        const m = String(body.miniatura || '').trim();
        if (m && !/^https:\/\//.test(m)) errores.miniatura = 'Debe ser una URL https.'; else out.miniatura = m;
    }
    if (has('publicado')) out.publicado = Boolean(body.publicado);
    if (has('destacado')) out.destacado = Boolean(body.destacado);
    return { errores, datos: out };
}

const manejarError = (res, err) => {
    if (err && err.code === '23505') return fail(res, 409, 'Ese video de YouTube ya está registrado.');
    if (err && err.status === 503) return fail(res, 503, 'La base de datos no está configurada todavía.');
    console.error('[PaginaCapital]', err);
    return fail(res, 500, 'Ocurrió un error en el servidor.');
};

// ───────────────────────── autenticación ─────────────────────────

// Límite simple de intentos de login por IP (en memoria): 8 cada 15 minutos.
const intentos = new Map();
function limiteLogin(req, res, next) {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const ahora = Date.now();
    const reg = intentos.get(ip) || { n: 0, desde: ahora };
    if (ahora - reg.desde > 15 * 60 * 1000) { reg.n = 0; reg.desde = ahora; }
    if (reg.n >= 8) return fail(res, 429, 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.');
    req._registroLogin = () => { reg.n += 1; intentos.set(ip, reg); };
    req._limpiarLogin = () => intentos.delete(ip);
    next();
}

function requireAdmin(req, res, next) {
    const secreto = process.env.CAPITAL_JWT_SECRET;
    if (!secreto) return fail(res, 503, 'El acceso de administración no está configurado.');
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return fail(res, 401, 'Inicia sesión para continuar.');
    try {
        const p = jwt.decode(token, secreto, false, 'HS256');
        if (p.sub !== 'admin-capital' || !p.exp || p.exp * 1000 < Date.now()) throw new Error('expirado');
        next();
    } catch (e) {
        return fail(res, 401, 'Tu sesión expiró. Vuelve a iniciar sesión.');
    }
}

// Asegura las tablas antes de cualquier ruta que use la base.
const conDb = (fn) => async (req, res) => {
    try { await db.ensureReady(); await fn(req, res); } catch (err) { manejarError(res, err); }
};

// ───────────────────────── rutas públicas ─────────────────────────

// GET /PaginaCapital/health — verificación de que el servicio está arriba
router.get('/health', async (req, res) => {
    let base = 'sin configurar';
    if (db.getPool()) {
        try { await db.query('SELECT 1'); base = 'ok'; } catch (e) { base = 'error'; }
    }
    return res.status(200).json({
        status: 'success',
        data: {
            proyecto: 'Comunidad Capital',
            servicio: 'PaginaCapital',
            estado: 'ok',
            base,
            fecha: new Date().toISOString(),
            activoDesde: iniciado.toISOString(),
            uptimeSegundos: Math.round(process.uptime())
        }
    });
});

// GET /PaginaCapital/episodios — episodios publicados, del más nuevo al más viejo
router.get('/episodios', conDb(async (req, res) => {
    const { rows } = await db.query(
        `SELECT * FROM capital_episodios WHERE publicado = TRUE
         ORDER BY numero DESC NULLS LAST, fecha DESC NULLS LAST, id DESC`);
    res.set('Cache-Control', 'no-cache'); // siempre fresco: los cambios del admin se ven al instante
    return ok(res, rows.map(toEpisodio));
}));

// GET /PaginaCapital/config — datos generales del podcast (serie en turno)
router.get('/config', conDb(async (req, res) => {
    const { rows } = await db.query('SELECT clave, valor FROM capital_config');
    const cfg = { serieActual: '' };
    rows.forEach((r) => { if (r.clave === 'serie_actual') cfg.serieActual = r.valor; });
    res.set('Cache-Control', 'no-cache'); // siempre fresco: los cambios del admin se ven al instante
    return ok(res, cfg);
}));

// ───────────────────────── administración ─────────────────────────

// POST /PaginaCapital/auth/login  { password }
router.post('/auth/login', limiteLogin, async (req, res) => {
    const hash = process.env.CAPITAL_ADMIN_PASSWORD_HASH;
    const secreto = process.env.CAPITAL_JWT_SECRET;
    if (!hash || !secreto) return fail(res, 503, 'El acceso de administración no está configurado.');
    const password = String((req.body && req.body.password) || '');
    const valida = password && await bcrypt.compare(password, hash);
    if (!valida) {
        req._registroLogin();
        return fail(res, 401, 'Contraseña incorrecta.');
    }
    req._limpiarLogin();
    const exp = Math.floor(Date.now() / 1000) + TOKEN_HORAS * 3600;
    const token = jwt.encode({ sub: 'admin-capital', exp }, secreto, 'HS256');
    return ok(res, { token, expira: new Date(exp * 1000).toISOString() });
});

// GET /PaginaCapital/admin/youtube?url=… — título y miniatura desde YouTube (oEmbed, sin llave)
router.get('/admin/youtube', requireAdmin, async (req, res) => {
    const id = youtubeId(req.query.url);
    if (!id) return fail(res, 400, 'Pega un link válido de YouTube.');
    try {
        const { data } = await axios.get('https://www.youtube.com/oembed', {
            params: { url: `https://www.youtube.com/watch?v=${id}`, format: 'json' },
            timeout: 8000,
        });
        return ok(res, {
            youtubeId: id,
            titulo: data.title || '',
            canal: data.author_name || '',
            miniatura: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        });
    } catch (e) {
        const st = e.response && e.response.status;
        if (st === 401 || st === 403) return fail(res, 422, 'El video es privado o no permite insertarse. Ponlo como público u oculto en YouTube.');
        if (st === 404 || st === 400) return fail(res, 404, 'No encontramos ese video en YouTube.');
        return fail(res, 502, 'No pudimos consultar YouTube. Intenta de nuevo.');
    }
});

// GET /PaginaCapital/admin/episodios — todos, incluidos los ocultos
router.get('/admin/episodios', requireAdmin, conDb(async (req, res) => {
    const { rows } = await db.query(
        'SELECT * FROM capital_episodios ORDER BY numero DESC NULLS LAST, fecha DESC NULLS LAST, id DESC');
    return ok(res, rows.map(toEpisodio));
}));

// POST /PaginaCapital/admin/episodios
router.post('/admin/episodios', requireAdmin, conDb(async (req, res) => {
    const { errores, datos } = validarEpisodio(req.body || {});
    if (Object.keys(errores).length) return fail(res, 400, 'Revisa los campos marcados.', { errores });
    const cols = Object.keys(datos);
    const vals = Object.values(datos);
    if (datos.destacado) await db.query('UPDATE capital_episodios SET destacado = FALSE WHERE destacado = TRUE');
    const { rows } = await db.query(
        `INSERT INTO capital_episodios (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING *`,
        vals);
    return ok(res, toEpisodio(rows[0]), 201);
}));

// PUT /PaginaCapital/admin/episodios/:id
router.put('/admin/episodios/:id', requireAdmin, conDb(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return fail(res, 400, 'Episodio no válido.');
    const { errores, datos } = validarEpisodio(req.body || {}, true);
    if (Object.keys(errores).length) return fail(res, 400, 'Revisa los campos marcados.', { errores });
    const cols = Object.keys(datos);
    if (!cols.length) return fail(res, 400, 'No hay cambios que guardar.');
    if (datos.destacado) await db.query('UPDATE capital_episodios SET destacado = FALSE WHERE destacado = TRUE AND id <> $1', [id]);
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const { rows } = await db.query(
        `UPDATE capital_episodios SET ${sets}, actualizado = NOW() WHERE id = $${cols.length + 1} RETURNING *`,
        [...Object.values(datos), id]);
    if (!rows.length) return fail(res, 404, 'Ese episodio ya no existe.');
    return ok(res, toEpisodio(rows[0]));
}));

// DELETE /PaginaCapital/admin/episodios/:id
router.delete('/admin/episodios/:id', requireAdmin, conDb(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return fail(res, 400, 'Episodio no válido.');
    const { rows } = await db.query('DELETE FROM capital_episodios WHERE id = $1 RETURNING id', [id]);
    if (!rows.length) return fail(res, 404, 'Ese episodio ya no existe.');
    return ok(res, { id });
}));

// PUT /PaginaCapital/admin/config  { serieActual }
router.put('/admin/config', requireAdmin, conDb(async (req, res) => {
    const serie = String((req.body && req.body.serieActual) || '').trim();
    if (serie.length > 120) return fail(res, 400, 'Máximo 120 caracteres.');
    await db.query(
        `INSERT INTO capital_config (clave, valor, actualizado) VALUES ('serie_actual', $1, NOW())
         ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado = NOW()`,
        [serie]);
    return ok(res, { serieActual: serie });
}));

module.exports = router;
module.exports._test = { youtubeId, validarEpisodio };
