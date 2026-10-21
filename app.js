'use strict';
// API general: back de los proyectos sin servidor propio.
//   /AppP, /AppP_V2   CooApp (v1 y v2) + notificaciones push
//   /PaginaCapital    Comunidad Capital (capital.paginascss.com)
const express = require('express');
const http = require('http');
require('dotenv').config({ quiet: true });

const app = express();
app.set('port', process.env.PORT || 4000);
app.disable('x-powered-by');

// Cuerpo JSON y formularios. 10 MB alcanza: ninguna ruta recibe archivos.
app.use(express.urlencoded({ extended: false, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
// Express 5 deja req.body en undefined si la petición no trae cuerpo; las rutas esperan un objeto.
app.use((req, res, next) => {
    if (req.body === undefined) req.body = {};
    next();
});

// JSON mal formado → 400 con mensaje
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ message: err.message });
    }
    next(err);
});

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Authorization, X-API-KEY, Origin, X-Requested-With, Content-Type, Accept, Access-Control-Allow-Request-Method, token');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.header('Allow', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    next();
});
app.options('/{*ruta}', (req, res) => res.sendStatus(204));

// Salud general del servicio
app.get('/', (req, res) => res.json({ status: 'success', data: { servicio: 'API general', estado: 'ok' } }));

// Proyectos
app.use('/AppP', require('./routes/AppPendientes'));
app.use('/AppP', require('./routes/pushNotifications'));
app.use('/AppP_V2', require('./routes/AppPendientes_V2_WEB'));
app.use('/PaginaCapital', require('./routes/PaginaCapital'));

// Errores no controlados (Express 5 también manda aquí las promesas rechazadas)
app.use((err, req, res, next) => {
    console.error('[API]', req.method, req.originalUrl, err);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ status: 'error', message: 'Ocurrió un error en el servidor.' });
});

module.exports = http.createServer(app);
