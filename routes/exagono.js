"use strict";
const express = require('express');
const utils = require('./../core/utils');
const { g_files } = require("./../keys");
const router = express.Router();
const NodeCache = require('node-cache');

// Configuración del caché (TTL de 10 segundos)
const cache = new NodeCache({ stdTTL: 30, checkperiod: 120 });

router.get('/GetDatosDistribuidor', async (req, res) => {
    try {
        const userAgent = req.headers['user-agent'] || 'Unknown';
        let origenSolicitud = 'Desconocido';

        if (userAgent.includes('Postman')) {
            origenSolicitud = 'Postman';
        } else if (userAgent.includes('Next.js')) {
            origenSolicitud = 'Next.js';
        } else {
            origenSolicitud = userAgent;
        }

        // Usar el host para identificar la solicitud
        const cacheKey = req.headers['host'] || 'unknown-host';

        // Verificar si la respuesta ya está en caché
        if (cache.has(cacheKey)) {
            console.log(`[${new Date().toLocaleTimeString()}] Respuesta obtenida desde el caché | Origen: ${origenSolicitud} | Host: ${cacheKey}`);
            return res.status(200).json({
                status: 'success',
                data: cache.get(cacheKey)
            });
        } else {
            console.log(`[${new Date().toLocaleTimeString()}] Respuesta sin caché | Origen: ${origenSolicitud} | Host: ${cacheKey}`);
        }

        // Simular procesamiento de datos
        await new Promise(resolve => setTimeout(resolve, 4000));
        const distribuidorData = {
            nombre: "Distribuidor Demo1",
            telefono: "555-123-4567",
            direccion: "Calle Falsa 123, Ciudad de México",
            horario: "Lunes a Viernes: 9:00 AM - 6:00 PM",
            servicios: [
                "Venta de autos nuevos",
                "Servicio y refacciones",
                "Atención personalizada"
            ],
            sitioWeb: "https://qa.distdemo.com",
            email: "demo@distdemo.com"
        };

        // Guardamos la respuesta en el caché
        cache.set(cacheKey, distribuidorData);

        // Devuelve los datos en formato JSON
        return res.status(200).json({
            status: 'success',
            data: distribuidorData
        });
    } catch (error) {
        // Manejo de errores
        return res.status(500).json({
            status: 'error',
            message: 'Hubo un error al obtener los datos del distribuidor',
            error: error.message
        });
    }
});

module.exports = router;
