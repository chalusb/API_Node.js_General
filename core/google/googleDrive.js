'use strict';
// Lectura y escritura de Google Sheets (rutas heredadas de CooApp: /GetPendientes y /SavePendientes).
const { google } = require('googleapis');
const { authenticate } = require('./auth');

// Lee un rango. Si falla regresa el error (las rutas ya lo validan así).
exports.readFileRange = async (spreadsheetId, sheetName, range) => {
    try {
        const auth = await authenticate();
        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!${range}` });
        return response.data.values;
    } catch (err) {
        return err;
    }
};

// Sobrescribe un rango con una matriz de valores. Regresa las celdas actualizadas.
exports.updateFile = async (spreadsheetId, sheetName, range, data) => {
    try {
        const auth = await authenticate();
        const sheets = google.sheets({ version: 'v4', auth });
        const res = await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${sheetName}!${range}`,
            valueInputOption: 'RAW',
            requestBody: { values: data },
        });
        return res.data.updatedCells;
    } catch (err) {
        return err;
    }
};
