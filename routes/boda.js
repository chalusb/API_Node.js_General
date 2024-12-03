"use strict";
const express = require('express');
const goo = require('./../core/google/googleDrive');
const utils = require('./../core/utils');
const {g_files} = require("./../keys");
const router = express.Router();


router.post('/addRow', async(req,res) => {
        try {           
    
            const fechaHoraActual = new Date();
            // Restar 6 horas (6 * 60 * 60000 milisegundos)
            fechaHoraActual.setTime(fechaHoraActual.getTime() - 6 * 60 * 60000);
         
            const fechaFormateada = fechaHoraActual.toISOString().split('T')[0];
            const horaFormateada = fechaHoraActual.toISOString().split('T')[1].split('.')[0];
            const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

            const obj_ins = [
                [
                    req.body.nombre,
                    req.body.telefono,
                    req.body.asistencia,
                    req.body.mensaje,
                    req.body.dispositivo,
                    fechaFormateada,
                    horaFormateada,
                    ip
                ]
            ];
            // Leer los datos existentes de la hoja
            const existingData = await goo.getRows(g_files.fileIdBoda, "Hoja1");
            const isDuplicate = existingData.some(row => {
                return row[0] === req.body.nombre || row[1] === req.body.telefono;
            });
            if (isDuplicate) {
                return res.status(409).json({ status: 'error',message: 'El nombre o teléfono ya existe' });
            }

            //const res_uk = await goo.updateFile(g_files.fileId,"Hoja1","A2:F",obj_ins);
            const res_uk = await goo.addRow(g_files.fileIdBoda,"Hoja1","A2:H",obj_ins);
    
          
            return res.status(200).json({ status: 'success', data: obj_ins });
        }
        catch(error) {
            return res.status(400).json({ message: error.stack });
        }
    }
    );



module.exports = router;