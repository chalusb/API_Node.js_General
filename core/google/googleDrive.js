const { authenticate } = require("./auth");
const { google } = require('googleapis');
const { g_files, g_config } = require('../../keys')
const { getCurrentDate, processResult } = require("../utils");
const _fs = require("fs");
const axios = require('axios');

const folderId = g_files.filesFolderId;
const rangeEnv = g_files.rangeGuide;
const statusRange = g_files.statusRange;

exports.getFileList = async () => {
  try {
    const auth = await authenticate();
    const drive = google.drive( { version: 'v3', auth } );
    const response = await drive.files.list({
      q: `'${ folderId }' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, createdTime)'
    });
    const files = response.data.files.sort(( a, b ) => new Date( b.createdTime ) - new Date( a.createdTime ));
    return files;
  } catch (err) {
    return err    
  } 
}

exports.readFileRange = async (spreadsheetId, sheet_name, range) => {
  try {
    const auth = await authenticate();
    const sheets = google.sheets({version: 'v4', auth});
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range:`${sheet_name}!${range}`,
    });
    const rows = response.data.values;
    return rows
  } catch (err) {
    return err;
  }
}

exports.updateFile = async(spreadsheetId, sheet_name, range, data) => { 
  try {
      const auth = await authenticate();
      const sheets = google.sheets({ version: 'v4', auth });
      
      const res = await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheet_name}!${range}`,
        valueInputOption: 'RAW',
        resource: {
          values: data,
        },
      });
      const cellsUpdated = res.data.updatedCells;
      return cellsUpdated;   
  } catch (err) {
    return err;
  }
}

exports.addRow = async(spreadsheetId, sheet_name, range, data) => { 
  try {
      const auth = await authenticate();
      const sheets = google.sheets({ version: 'v4', auth });
      
      res = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheet_name}!${range}`,
        valueInputOption: 'RAW',
        resource: {
          values: data,
        },
      });
     
      const cellsUpdated = res.data.updatedCells;
      return cellsUpdated;   
  } catch (err) {
    return err;
  }
}

exports.getRows = async (spreadsheetId, sheet_name) => {
  try {
    const auth = await authenticate();
    const sheets = google.sheets({ version: 'v4', auth });

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheet_name}!A:H`, // Adjust range as needed (optional)
    });

    return res.data.values || []; // Return empty array if no data found
  } catch (err) {
    return err;
  }
};