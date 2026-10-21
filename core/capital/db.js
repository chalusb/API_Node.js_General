"use strict";
// Base de datos Postgres de Comunidad Capital (Railway).
// Usa DATABASE_URL (en Railway: referencia a la variable del servicio Postgres).
const { Pool } = require('pg');

let pool = null;

// Permite inyectar un pool de pruebas (pg-mem) sin tocar el resto del código.
function setPool(p) { pool = p; }

function getPool() {
    if (pool) return pool;
    if (!process.env.DATABASE_URL) return null;
    const url = process.env.DATABASE_URL;
    // La red interna de Railway (*.railway.internal) no usa SSL; la URL pública sí.
    const ssl = /railway\.internal|localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
    pool = new Pool({ connectionString: url, ssl, max: 5, idleTimeoutMillis: 30000 });
    pool.on('error', (err) => console.error('[capital-db] error en el pool:', err.message));
    return pool;
}

async function query(text, params) {
    const p = getPool();
    if (!p) throw Object.assign(new Error('DATABASE_URL no está configurada'), { status: 503 });
    return p.query(text, params);
}

// Crea las tablas si no existen. Se llama al arrancar y es idempotente.
async function init() {
    await query(`
        CREATE TABLE IF NOT EXISTS capital_episodios (
            id SERIAL PRIMARY KEY,
            youtube_id VARCHAR(20) NOT NULL UNIQUE,
            titulo TEXT NOT NULL,
            serie TEXT NOT NULL DEFAULT '',
            numero INTEGER,
            fecha DATE,
            duracion VARCHAR(20) NOT NULL DEFAULT '',
            descripcion TEXT NOT NULL DEFAULT '',
            miniatura TEXT NOT NULL DEFAULT '',
            publicado BOOLEAN NOT NULL DEFAULT TRUE,
            destacado BOOLEAN NOT NULL DEFAULT FALSE,
            creado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            actualizado TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    await query(`
        CREATE TABLE IF NOT EXISTS capital_config (
            clave VARCHAR(60) PRIMARY KEY,
            valor TEXT NOT NULL DEFAULT '',
            actualizado TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
}

let ready = null;
// Inicializa una sola vez; si falla, reintenta en la siguiente petición.
function ensureReady() {
    if (!ready) ready = init().catch((err) => { ready = null; throw err; });
    return ready;
}

module.exports = { query, init, ensureReady, setPool, getPool };
