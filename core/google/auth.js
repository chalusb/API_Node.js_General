const { google } = require('googleapis');
const { JWT } = require('google-auth-library');
const { g_auth_keys } = require('../../keys')

exports.authenticate = async ()  => {
  const client = new google.auth.JWT(g_auth_keys);

  await client.authorize();

  return client;
  
}