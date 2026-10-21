'use strict';
// Configuración leída de variables de entorno (en producción: variables de Railway).

module.exports = {
    // Cuenta de servicio de Google (Sheets) usada por CooApp
    g_auth_keys: {
        email: process.env.G_CLIENT_EMAIL,
        key: process.env.G_PRIVATE_KEY,
        keyId: process.env.G_PRIVATE_KEY_ID,
        scopes: process.env.G_SCOPES ? process.env.G_SCOPES.split(',') : [],
    },
    g_files: {
        fileIdAppP: process.env.G_FILE_ID_PENDIENTES, // hoja "Pendientes" de CooApp
    },
};
