"use strict";
// Genera los valores para las variables del admin de Comunidad Capital.
// Uso: node scripts/capital-hash.js "la-contraseña"
// Copia las dos líneas que imprime a las variables del servicio en Railway.
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const password = process.argv[2];
if (!password || password.length < 10) {
    console.error('Escribe una contraseña de al menos 10 caracteres: node scripts/capital-hash.js "…"');
    process.exit(1);
}
bcrypt.hash(password, 12).then((hash) => {
    console.log('CAPITAL_ADMIN_PASSWORD_HASH=' + hash);
    console.log('CAPITAL_JWT_SECRET=' + crypto.randomBytes(48).toString('base64url'));
});
