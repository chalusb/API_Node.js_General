# API general

Back en Node.js para los proyectos que no tienen servidor propio. Corre en Railway (`Project_API_General` → servicio `API_Node.js_General`):
https://apinodejsgeneral-production.up.railway.app

| Ruta base | Proyecto | Archivo |
|---|---|---|
| `/AppP` | CooApp v1 (se mantiene por apps móviles viejas) + notificaciones push | `routes/AppPendientes.js`, `routes/pushNotifications.js` |
| `/AppP_V2` | CooApp v2 (web actual) | `routes/AppPendientes_V2_WEB.js` |
| `/PaginaCapital` | Comunidad Capital: podcast y admin | `routes/PaginaCapital.js` |
| `/` | Salud general del servicio | `app.js` |

Cada proyecto tiene su archivo en `routes/` y se monta en `app.js`. Lo compartido vive en `core/` (`firebase/`, `google/` para Sheets y `capital/` para la base de Postgres de Capital). Cada proyecto que necesite base de datos lleva la suya, con su nombre (por ejemplo `BD_Capital`).

## Correr en local

Requiere Node 22 o más reciente.

```bash
npm install
cp .env.example .env   # y llena los valores
npm run dev            # http://localhost:4000 (se reinicia solo al guardar)
```

## Variables

La lista completa, con comentarios, está en `.env.example`. En producción viven en las variables del servicio en Railway; el `.env` es solo local y no se sube al repo.

## Comunidad Capital

- Públicas: `GET /PaginaCapital/health`, `GET /PaginaCapital/episodios`, `GET /PaginaCapital/config`.
- Admin (con token): `POST /auth/login`, `GET|POST /admin/episodios`, `PUT|DELETE /admin/episodios/:id`, `PUT /admin/config`, `GET /admin/youtube?url=`.
- Las tablas (`capital_episodios`, `capital_config`) se crean solas al arrancar.
- Contraseña del admin: `node scripts/capital-hash.js "contraseña"` imprime `CAPITAL_ADMIN_PASSWORD_HASH` y `CAPITAL_JWT_SECRET` para Railway.
