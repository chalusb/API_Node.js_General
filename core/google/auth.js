'use strict';
const { google } = require('googleapis');
const { g_auth_keys } = require('../../keys');

// Cliente autenticado con la cuenta de servicio de Google.
exports.authenticate = async () => {
    const client = new google.auth.JWT({
        email: g_auth_keys.email,
        key: g_auth_keys.key,
        keyId: g_auth_keys.keyId,
        scopes: g_auth_keys.scopes,
    });
    await client.authorize();
    return client;
};
