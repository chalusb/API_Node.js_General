'use strict'

const express = require('express');
const http = require('http');
const dotenv = require('dotenv').config();

//init
const app = express();

//settings
app.set('port', process.env.PORT || 4000);

//Middlewares
app.use(express.urlencoded({extended: false, limit: '1000mb'}));
app.use(express.json({limit: '1000mb'}));

//Global
app.use((err,req,res,next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        console.error(err);
        return res.status(400).json({ message: err.message });
    }
    next();
})

//configurar cabeceras http
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Authorization, X-API-KEY, Origin, X-Requested-With, Content-Type, Accept, Access-Control-Allow-Request-Method, token');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.header('Allow', 'GET, POST, OPTIONS, PUT, DELETE');
    next();
});

//Routes
app.use('/kids',require('./routes/kids'));
app.use('/boda',require('./routes/boda'));

//Public
app.use(express.static('public'));

const server = http.createServer(app);

module.exports = server;