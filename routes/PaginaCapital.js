"use strict";
// Back de la página de Comunidad Capital (capital.paginascss.com).
// Se monta en app.js como /PaginaCapital
const express = require('express');
const router = express.Router();

const iniciado = new Date();

// GET /PaginaCapital/health — verificación de que el servicio está arriba
router.get('/health', (req, res) => {
    return res.status(200).json({
        status: 'success',
        data: {
            proyecto: 'Comunidad Capital',
            servicio: 'PaginaCapital',
            estado: 'ok',
            fecha: new Date().toISOString(),
            activoDesde: iniciado.toISOString(),
            uptimeSegundos: Math.round(process.uptime())
        }
    });
});

module.exports = router;
