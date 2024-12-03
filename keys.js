'use strict'

module.exports = {
    security: {
        secretKeyToken: process.env.SECRET_KEY,
    },
    database: {
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME,
        port:  process.env.DB_PORT,
        multipleStatements: true,
    },
    g_auth_keys: {
        email: process.env.G_CLIENT_EMAIL, 
        key: process.env.G_PRIVATE_KEY,
        keyId: process.env.G_PRIVATE_KEY_ID,
        scopes:  process.env.G_SCOPES.split(',')
    },
    g_files: {
        folderId: process.env.G_FOLDER_ID,
        fileId: process.env.G_FILE_ID,
        fileIdResp: process.env.G_FILE_ID_RESPALDO,
        fileIdBoda: process.env.G_FILE_ID_BODA,
        rangeGuide: process.env.G_GUIDE_RANGE,
        statusRange: process.env.G_STATUS_RANGE
    },
}