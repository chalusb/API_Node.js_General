"use strict";
const fs = require('fs');
const express = require('express');
const goo = require('./../core/google/googleDrive');
const utils = require('./../core/utils');
const {g_files} = require("./../keys");
const router = express.Router();
const { PDFDocument, rgb, StandardFonts, degrees, TextAlignment } = require('pdf-lib');
const QRCode = require('qrcode');
const { json } = require('body-parser');

router.get('/getkids', async(req,res) => {
        try {
            const res_gd = await goo.readFileRange(g_files.fileId,"Hoja1","A1:J");
            const cols = res_gd.shift()
            const uts = utils.arrayToJson(cols ,res_gd);
            return res.status(200).json({ status: 'success', data: uts });
        }
        catch(error) {
            return res.status(400).json({ message: error.stack });
        }
    }
);

router.post('/getAllkidsbykey', async (req, res) => {
    try {
        const res_gd = await goo.readFileRange(g_files.fileId, "Hoja1", "A1:K");
        const cols = res_gd.shift();  // Obtener los encabezados
        const k = req.body.key, v = req.body.val;
        
        // Convertir el archivo a JSON y filtrar los resultados basados en el key y value proporcionados
        let uts = await utils.arrayToJson(cols, res_gd)
            .map(e => cleanObjectFields(e))  // Limpiar campos vacíos
            .map(e => cleanObjectKeys(e))    // Limpiar claves de los objetos
            .filter(e => {
                const value = e[k] || "";  // Si e[k] es undefined o null, se asigna ""
                return value.toLowerCase().includes(v.toLowerCase());  // Compara en minúsculas
            });

        // Devolver la información del niño sin generar el PDF
        return res.status(200).json({ status: 'success', data: uts });
    } 
    catch (error) {
        return res.status(400).json({ message: error.stack });
    }
});

//un niño un pdf
router.post('/getkidsbykeyPDF', async(req,res) => {
    try {
        const res_gd = await goo.readFileRange(g_files.fileId,"Hoja1","A1:K");
        const cols = res_gd.shift()
        const k = req.body.key, v = req.body.val;
        const uts = await utils.arrayToJson(cols ,res_gd).filter(e=> e[k].includes(v));
        
        const url = "misitioweb/conavi/" + uts[0].id;
        let pdfDoc = await PDFDocument.create();
        pdfDoc = await PDFDocument.load(await pdfDoc.save());                        
        let pages = pdfDoc.getPages();
        let current_page = pages[0];
        const { width, height } = current_page.getSize();

        const qrImage = await QRCode.toDataURL(url, { errorCorrectionLevel: 'L', quality: 0.1 });
        const pngImage = await pdfDoc.embedPng(qrImage);

        // Textos separados por líneas
        const lines = [
            "Nombre: " + uts[0].nombre + " " + uts[0].apellido,
            "Regalo: " + uts[0].regalo,
            "Codigo: " + uts[0].id
        ];

        let yPosition = 700;  // Posición inicial en Y
        const lineSpacing = 30;  // Espaciado entre líneas
        // Dibujar cada línea por separado
        lines.forEach(line => {
            current_page.drawText(line, {
                x: parseInt((width / 2) - 100),
                y: yPosition,  // Coloca la línea en la posición actual
                width: 200,
                height: 200
            });
            yPosition -= lineSpacing;  // Ajusta la posición Y para la siguiente línea
        });
        current_page.drawImage(pngImage, {
            x: parseInt((width/2)-100),
            y: 44,
            width: 200,
            height: 200
        });
        const pdfBytes = await pdfDoc.saveAsBase64();
            

        uts[0].pdf = pdfBytes;
        

        return res.status(200).json({ status: 'success', data: uts });
    }
    catch(error) {
        return res.status(400).json({ message: error.stack });
    }
}
);

//un pdf por niño
router.post('/getAllkidsbykeyAndPDF', async(req,res) => {
    try {
        const res_gd = await goo.readFileRange(g_files.fileId,"Hoja1","A1:K");
        const cols = res_gd.shift()
        const k = req.body.key, v = req.body.val;
        let uts = await utils.arrayToJson(cols, res_gd)
        .map(e => cleanObjectFields(e))  // Limpia los campos vacíos
        .map(e => cleanObjectKeys(e))  // Limpia las claves de los objetos
        .filter(e => {
            const value = e[k] || "";  // Si e[k] es undefined o null, se asigna ""
            return value.toLowerCase().includes(v.toLowerCase());  // Compara en minúsculas
        });

        

        await Promise.all( uts.map(async e =>{
            const url = "https://jsweb.com.mx/CoNavi/index.html?clave=" + uts.CLAVE + "#captura";
            let pdfDoc = await PDFDocument.create();
            
            pdfDoc = await PDFDocument.load(await pdfDoc.save());                        
            let pages = pdfDoc.getPages();
            let current_page = pages[0];
            const { width, height } = current_page.getSize();
            const qrImage = await QRCode.toDataURL(url, { errorCorrectionLevel: 'L', quality: 0.1 });
            const pngImage = await pdfDoc.embedPng(qrImage);
            // Textos separados por líneas
            const lines = [
                "Nombre: " + e.NOMBRE ,
                "Regalo: " + e.REGALOS,
                "Codigo: " + e.CLAVE
            ];
            let yPosition = 700;  // Posición inicial en Y
            const lineSpacing = 30;  // Espaciado entre líneas
            // Dibujar cada línea por separado
            lines.forEach(line => {
                current_page.drawText(line, {
                    x: parseInt((width / 2) - 100),
                    y: yPosition,  // Coloca la línea en la posición actual
                    width: 200,
                    height: 200
                });
                yPosition -= lineSpacing;  // Ajusta la posición Y para la siguiente línea
            });
            current_page.drawImage(pngImage, {
                x: parseInt((width/2)-100),
                y: 44,
                width: 200,
                height: 200
            });
            const pdfBytes = await pdfDoc.saveAsBase64();
                

            e.pdf = pdfBytes;
        }));
        
        

        return res.status(200).json({ status: 'success', data: uts });
    }
    catch(error) {
        return res.status(400).json({ message: error.stack });
    }
}
);

//Un pdf varias paginas
router.post('/getAllkidsbykeyAllPDF', async(req,res) => {
    try {
        const res_gd = await goo.readFileRange(g_files.fileId,"Hoja1","A1:F");
        const cols = res_gd.shift()
        const k = req.body.key, v = req.body.val;
        let uts = await utils.arrayToJson(cols ,res_gd).filter(e=> e[k].includes(v));
        let pdfDoc2 = await PDFDocument.create();

        await Promise.all( uts.map(async e =>{
            const url = "https://jsweb.com.mx/CoNavi/index.html?clave=" + uts.CLAVE + "#captura";
            let pdfDoc = await PDFDocument.create();            
            pdfDoc = await PDFDocument.load(await pdfDoc.save());                        
            let pages = pdfDoc.getPages();
            let current_page = pages[0];
            const { width, height } = current_page.getSize();
            const qrImage = await QRCode.toDataURL(url, { errorCorrectionLevel: 'L', quality: 0.1 });
            const pngImage = await pdfDoc.embedPng(qrImage);
            // Textos separados por líneas
            const lines = [
                "Nombre: " + e.nombre + " " + e.apellido,
                "Regalo: " + e.regalo,
                "Codigo: " + e.id
            ];
            let yPosition = 700;  // Posición inicial en Y
            const lineSpacing = 30;  // Espaciado entre líneas
            // Dibujar cada línea por separado
            lines.forEach(line => {
                current_page.drawText(line, {
                    x: parseInt((width / 2) - 100),
                    y: yPosition,  // Coloca la línea en la posición actual
                    width: 200,
                    height: 200
                });
                yPosition -= lineSpacing;  // Ajusta la posición Y para la siguiente línea
            });
            current_page.drawImage(pngImage, {
                x: parseInt((width/2)-100),
                y: 44,
                width: 200,
                height: 200
            });
            const pdfBytes = await pdfDoc.saveAsBase64();                

            //e.pdf = pdfBytes;
            let srcDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
            const copiedPages   = await pdfDoc2.copyPages(srcDoc, [0]); 
            pdfDoc2.addPage(copiedPages[0]);
        }));
        
        const pdfBytes = await pdfDoc2.saveAsBase64();

        return res.status(200).json({ status: 'success', data: uts, pdf: pdfBytes });
    }
    catch(error) {
        return res.status(400).json({ message: error.stack });
    }
}
);

router.post('/setAsist', async (req, res) => {
    try {
        const res_gd = await goo.readFileRange(g_files.fileId, "Hoja1", "A1:K");  // Incluye la columna HORA_LLEGADA
        const cols = res_gd.shift();  // Obtener los encabezados
        let kids_data = utils.arrayToJson(cols, res_gd);  // Convertir a JSON
        let arr_kids = [];
        const errors = [];

        const llegoValue = req.body.llego === "1" ? "1" : "0";  // Valor de "LLEGO" que se debe actualizar (1 o 0)
        const capturistaValue = req.body.capturista || "";  // Nombre del capturista
        //const currentTime = new Date().toLocaleString('es-MX');  // Capturar fecha y hora en el mismo campo
        let currentTime = formatDate();

        // Obtener el ID directamente como un string
        const id = req.body.ids.trim();  // Obtener el ID sin espacios adicionales

        // Buscar si la CLAVE existe en los datos
        const child = kids_data.find(e => e.CLAVE === id);
        if (!child) {
            // Si no se encuentra la CLAVE, devolver un error 409
            return res.status(409).json({ 
                status: 'error', 
                message: `La CLAVE ${id} no existe en los registros.` 
            });
        }

        // Mapear los datos y actualizar las columnas "LLEGO", "CAPTURISTA", y "HORA_LLEGADA"
        kids_data = kids_data.map(e => {
            if (id === e.CLAVE) {  // Comparar directamente el ID con CLAVE
                if (e.LLEGO === "1") {
                    // Si ya llegó, agregar el error para manejarlo
                    const [fecha, hora] = (e.HORA_LLEGADA || "desconocida").split(", ");  // Separar fecha y hora
                    errors.push({
                        CLAVE: e.CLAVE,
                        NOMBRE: e.NOMBRE,
                        message: `Ya ha llegado a las ${hora} del día ${fecha} y fue capturado por ${e.CAPTURISTA || "desconocido"}`  // Formato de hora y fecha
                    });
                } else {
                    // Si no ha llegado, actualizar los datos correctamente
                    arr_kids.push(e);  // Añadir el registro a arr_kids si se actualiza
                    return Object.assign({}, e, { 
                        CAPTURISTA: capturistaValue,
                        HORA_LLEGADA: llegoValue === "1" ? currentTime : "",  // Guardar fecha y hora actuales
                        LLEGO: llegoValue
                    });
                }
            }
            return e;  // Devolver el objeto sin cambios si no se actualiza
        });

        // Si hay errores, los devolvemos en la respuesta
        if (errors.length > 0) {
            return res.status(400).json({ status: 'error', errors });
        }

        // Convertir los datos a un formato de array que Google Sheets pueda entender
        const obj_ins = kids_data.map(e => Object.values(e));
        // Actualizar el archivo de Google Sheets con los nuevos datos
        const res_uk = await goo.updateFile(g_files.fileId, "Hoja1", "A2:K", obj_ins);

        // Devolver una respuesta exitosa con los registros actualizados
        return res.status(200).json({ status: 'success', data: arr_kids });
    }
    catch (error) {
        return res.status(400).json({ message: error.stack });
    }
});

router.post('/removeAsist', async (req, res) => {
    try {
        const res_gd = await goo.readFileRange(g_files.fileId, "Hoja1", "A1:K");  // Leer los datos de la hoja
        const cols = res_gd.shift();  // Obtener los encabezados
        let kids_data = utils.arrayToJson(cols, res_gd);  // Convertir los datos a JSON
        let arr_kids = [];
        const errors = [];

        // Obtener el ID directamente como un string
        const id = req.body.ids.trim();  // Obtener el ID sin espacios adicionales

        // Buscar si la CLAVE existe en los datos
        const child = kids_data.find(e => e.CLAVE === id);
        if (!child) {
            // Si no se encuentra la CLAVE, devolver un error 409
            return res.status(409).json({ 
                status: 'error', 
                message: `La CLAVE ${id} no existe en los registros.` 
            });
        }

        // Mapear los datos y actualizar las columnas "LLEGO", "CAPTURISTA", y "HORA_LLEGADA"
        kids_data = kids_data.map(e => {
            if (id === e.CLAVE) {  // Comparar directamente el ID con CLAVE
                if (e.LLEGO === "0") {
                    // Si ya está en 0, devolver un error
                    errors.push({
                        CLAVE: e.CLAVE,
                        NOMBRE: e.NOMBRE,
                        message: `El registro ya está marcado como "No asistió".`
                    });
                } else {
                    // Si estaba en 1, actualizar a 0 y limpiar CAPTURISTA y HORA_LLEGADA
                    arr_kids.push(e);  // Añadir el registro a arr_kids si se actualiza
                    return Object.assign({}, e, { 
                        CAPTURISTA: "",        // Limpiar capturista
                        HORA_LLEGADA: "",     // Limpiar hora de llegada
                        LLEGO: "0"            // Marcar como "No asistió"
                    });
                }
            }
            return e;  // Devolver el objeto sin cambios si no se actualiza
        });

        // Si hay errores, los devolvemos en la respuesta
        if (errors.length > 0) {
            return res.status(400).json({ status: 'error', errors });
        }

        // Convertir los datos a un formato de array que Google Sheets pueda entender
        const obj_ins = kids_data.map(e => Object.values(e));
        // Actualizar el archivo de Google Sheets con los nuevos datos
        const res_uk = await goo.updateFile(g_files.fileId, "Hoja1", "A2:K", obj_ins);

        // Devolver una respuesta exitosa con los registros actualizados
        return res.status(200).json({ status: 'success', data: arr_kids });
    }
    catch (error) {
        return res.status(400).json({ message: error.stack });
    }
});

router.post('/setAsistAcomodo', async (req, res) => {
    try {
        const res_gd = await goo.readFileRange(g_files.fileId, "Hoja1", "A1:N"); // Leer datos del archivo
        const cols = res_gd.shift(); // Obtener encabezados
        let kids_data = utils.arrayToJson(cols, res_gd); // Convertir a JSON
        const errors = [];
        let arr_kids = [];

        const id = req.body.ids.trim(); // ID de la CLAVE del niño
        const capturistaValue = req.body.capturista || ""; // Nombre del capturista
        const area = req.body.area || ""; // Área ingresada
        const currentTime = formatDate();

        // Buscar el registro correspondiente a la CLAVE
        const child = kids_data.find(e => e.CLAVE === id);
        if (!child) {
            return res.status(409).json({
                status: 'error',
                message: `La CLAVE ${id} no existe en los registros.`,
            });
        }

        // Validar si ya está capturado completamente
        if (
            child.LLEGO === "1" &&
            child.CAPTURISTA &&
            child.HORA_LLEGADA &&
            child.AREA &&
            child.RESPONSABLE &&
            child.HORA_ACOMODO
        ) {
            return res.status(400).json({
                status: 'error',
                message: `El niño con CLAVE ${id} ya está capturado. Fue capturado por ${child.RESPONSABLE} a las ${child.HORA_ACOMODO}. Y Esta en el Area: ${child.AREA} `,
            });
        }

        // Actualizar datos según el valor de "LLEGO"
        kids_data = kids_data.map(e => {
            if (e.CLAVE === id) {
                arr_kids.push(e); 
                if (e.LLEGO === "1") {
                    // Si ya llegó, actualizamos solo AREA, RESPONSABLE y HORA_ACOMODO
                    return {
                        ...e,
                        AREA: area,
                        RESPONSABLE: capturistaValue,
                        HORA_ACOMODO: currentTime,
                    };
                } else {
                    // Si no ha llegado, actualizamos todo
                    return {
                        ...e,
                        CAPTURISTA: capturistaValue,
                        HORA_LLEGADA: currentTime,
                        LLEGO: "1",
                        AREA: area,
                        RESPONSABLE: capturistaValue, // El capturista también es el responsable
                        HORA_ACOMODO: currentTime,
                    };
                }
            }
            return e; // Retornar el objeto sin cambios si no coincide
        });

        // Convertir los datos a un array para Google Sheets
        const obj_ins = kids_data.map(e => Object.values(e));

        // Actualizar el archivo de Google Sheets
        await goo.updateFile(g_files.fileId, "Hoja1", "A2:N", obj_ins);

        // Respuesta exitosa
        return res.status(200).json({ status: 'success', data: arr_kids });

    } catch (error) {
        return res.status(400).json({
            status: 'error',
            message: error.message,
            stack: error.stack,
        });
    }
});

router.post('/getPDFbyClave', async (req, res) => {
    try {
        // Lee los datos del archivo de Google Sheets
        const res_gd = await goo.readFileRange(g_files.fileId, "Hoja1", "A1:K");
        const cols = res_gd.shift();
        const clave = req.body.clave.trim();  // Obtiene la clave del cuerpo de la solicitud
        
        // Convierte los datos en JSON y busca el niño con la clave proporcionada
        const uts = utils.arrayToJson(cols, res_gd).find(e => e.CLAVE === clave);
        
        if (!uts) {
            return res.status(404).json({ status: 'error', message: 'No se encontró ningún niño con esa clave' });
        }
        
        // URL correcto para generar el código QR
        const url = "https://jsweb.com.mx/CoNavi/index.html?clave=" + uts.CLAVE + "#captura";
        
        // Crear un nuevo documento PDF
        let pdfDoc = await PDFDocument.create();
        pdfDoc = await PDFDocument.load(await pdfDoc.save());
        let pages = pdfDoc.getPages();
        let current_page = pages[0];
        const { width, height } = current_page.getSize();

        // Cargar y agregar el logo
        const logoImageBytes = await fs.promises.readFile('./assets/logo.png');  // Ruta del logo
        const pngLogo = await pdfDoc.embedPng(logoImageBytes);
        
        // Tamaño y posición del logo
        const logoWidth = 200;
        const logoHeight = 200;

        // Centrar el logo
        current_page.drawImage(pngLogo, {
            x: (width - logoWidth) / 2,  // Centrar horizontalmente
            y: height - logoHeight - 50,  // Posición ajustada desde la parte superior
            width: logoWidth,
            height: logoHeight
        });

        // Agregar el texto "CONAVI 2024" debajo del logo, centrado
        current_page.drawText("CoNavi 2024", {
            x: (width - 100) / 2,  // Centrar el texto horizontalmente
            y: height - logoHeight - 90,  // Justo debajo del logo
            size: 14,  // Tamaño reducido del texto
            color: rgb(0, 0, 0)
        });

        // Generar un código QR con el enlace del niño
        const qrImage = await QRCode.toDataURL(url, { errorCorrectionLevel: 'L', quality: 0.1 });
        const pngImage = await pdfDoc.embedPng(qrImage);

        // Ajustar el texto con los detalles del niño
        const lines = [
            "CLAVE: " + uts.CLAVE,
            "NOMBRE: " + uts.NOMBRE,
        ];

        // Función para dividir texto largo en varias líneas
        const splitText = (text, maxLineLength) => {
            const splittedLines = [];
            while (text.length > maxLineLength) {
                let splitIndex = text.lastIndexOf(' ', maxLineLength);
                if (splitIndex === -1) splitIndex = maxLineLength;
                splittedLines.push(text.substring(0, splitIndex));
                text = text.substring(splitIndex + 1);
            }
            splittedLines.push(text);
            return splittedLines;
        };

        let yPosition = 470;       // Ajustamos la posición para el texto
        const lineSpacing = 20;    // Espaciado entre líneas
        const maxLineLength = 30;  // Máximo número de caracteres por línea

        // Recorrer y dividir cada línea si es necesario
        lines.forEach(line => {
            const splittedLines = splitText(line, maxLineLength);
            splittedLines.forEach(splittedLine => {
                current_page.drawText(splittedLine, {
                    x: (width - 250) / 2,  // Centrar el texto horizontalmente
                    y: yPosition,
                    size: 20,              // Tamaño del texto
                    color: rgb(0, 0, 0)
                });
                yPosition -= lineSpacing;
            });
        });

        // Agregar el código QR en la parte inferior, centrado
        const qrSize = 200;  // Tamaño del QR
        current_page.drawImage(pngImage, {
            x: (width - qrSize) / 2,  // Centrar el QR horizontalmente
            y: 50,  // Cerca de la parte inferior del PDF
            width: qrSize,
            height: qrSize
        });

        // Convertir el PDF a base64
        const pdfBytes = await pdfDoc.saveAsBase64();

        // Devolver el PDF en base64
        return res.status(200).json({ status: 'success', pdf: pdfBytes });
    } catch (error) {
        return res.status(400).json({ message: error.stack });
    }
});

router.post('/getInstitucionesOPadrinos', async (req, res) => {
    try {
        // Leer el archivo desde Google Sheets
        const res_gd = await goo.readFileRange(g_files.fileId, "Hoja1", "A1:N"); // Incluye todas las columnas relevantes
        const cols = res_gd.shift(); // Obtener encabezados
        let kids_data = utils.arrayToJson(cols, res_gd); // Convertir a JSON

        // Obtener el tipo de búsqueda (INSTITUCION o PADRINO) desde el cuerpo del request
        const tipoBusqueda = req.body.tipoBusqueda;

        // Validar que el tipo de búsqueda sea válido
        if (!["INSTITUCION", "PADRINO"].includes(tipoBusqueda)) {
            return res.status(400).json({
                status: 'error',
                message: 'El tipo de búsqueda debe ser "INSTITUCION" o "PADRINO".',
            });
        }

        // Contar las repeticiones sin normalizar los valores
        const conteo = {};
        kids_data.forEach(e => {
            const valor = e[tipoBusqueda]?.trim(); // Respetar espacios y mayúsculas/minúsculas
            if (valor && valor !== "") {
                conteo[valor] = (conteo[valor] || 0) + 1; // Incrementar el conteo
            }
        });

        // Ordenar por cantidad de repeticiones en orden descendente
        const topFrecuentes = Object.entries(conteo)
            .sort((a, b) => b[1] - a[1]) // Ordenar por valor (repeticiones) en orden descendente
            .slice(0, tipoBusqueda === "INSTITUCION" ? 45 : 700) // Tomar los primeros 35 o 50 según el caso
            .map(([clave]) => clave); // Extraer solo los nombres originales

        // Ordenar alfabéticamente los más frecuentes
        const resultado = topFrecuentes.sort((a, b) => a.localeCompare(b, 'es')); // Ordenar alfabéticamente

        // Responder con el JSON de resultados
        return res.status(200).json({
            status: 'success',
            data: resultado,
        });
    } catch (error) {
        // Manejar errores
        return res.status(400).json({
            status: 'error',
            message: error.message,
            stack: error.stack,
        });
    }
});

router.post('/filterInstitucionesOPadrinos', async (req, res) => {
    try {
        // Leer el archivo desde Google Sheets
        const res_gd = await goo.readFileRange(g_files.fileId, "Hoja1", "A1:N"); // Incluye todas las columnas relevantes
        const cols = res_gd.shift(); // Obtener encabezados
        let kids_data = utils.arrayToJson(cols, res_gd); // Convertir a JSON

        // Obtener el tipo de búsqueda (INSTITUCION o PADRINO) desde el cuerpo del request
        const tipoBusqueda = req.body.tipoBusqueda;
        const nombres = req.body.nombre?.split(',').map(n => n.trim()); // Dividir los nombres y eliminar espacios

        // Validar tipo de búsqueda
        if (!["INSTITUCION", "PADRINO"].includes(tipoBusqueda)) {
            return res.status(400).json({
                status: 'error',
                message: 'El tipo de búsqueda debe ser "INSTITUCION" o "PADRINO".',
            });
        }

        // Validar que los nombres existan
        if (!nombres || nombres.length === 0) {
            return res.status(400).json({
                status: 'error',
                message: 'Debe proporcionar al menos un nombre en el campo "nombre".',
            });
        }

        // Filtrar los registros que coincidan con los nombres proporcionados
        const resultado = kids_data.filter(e => nombres.includes(e[tipoBusqueda]?.trim()))
            .map(e => ({
                INSTITUCION: e.INSTITUCION,
                PADRINO: e.PADRINO,
                CLAVE: e.CLAVE,
                LLEGO: e.LLEGO
            }));

        // Responder con los datos filtrados
        return res.status(200).json({
            status: 'success',
            data: resultado,
        });
    } catch (error) {
        // Manejar errores
        return res.status(400).json({
            status: 'error',
            message: error.message,
            stack: error.stack,
        });
    }
});













function formatDate(){
    let currentTime = new Date();
    currentTime.setHours(currentTime.getHours() - 6);        
    const date = ("0" + currentTime.getDate()).slice(-2);
    const month = ("0" + (currentTime.getMonth() + 1)).slice(-2);
    const year = currentTime.getFullYear();
    const hours = ("0" + currentTime.getHours()).slice(-2);
    const minutes = ("0" + currentTime.getMinutes()).slice(-2);
    const seconds = ("0" + currentTime.getSeconds()).slice(-2);
    const t = hours < 12 ? "a.m." : "p.m.";
    const strdate = `${date}/${month}/${year}, ${hours}:${minutes}:${seconds} ${t}`;
    return strdate;
}

function cleanObjectFields(obj) {
    let cleanedObj = {};
    for (let key in obj) {
        if (obj.hasOwnProperty(key)) {
            cleanedObj[key] = obj[key] || ""; // Si el campo está vacío o es null/undefined, se convierte en ""
        }
    }
    return cleanedObj;
}
function cleanObjectKeys(obj) {
    let cleanedObj = {};
    for (let key in obj) {
        if (obj.hasOwnProperty(key)) {
            let cleanedKey = key.replace(/\s+/g, '_');  // Reemplaza los espacios por guiones bajos
            cleanedObj[cleanedKey] = obj[key];
        }
    }
    return cleanedObj;
}


module.exports = router;