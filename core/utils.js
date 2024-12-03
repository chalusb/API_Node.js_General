"use strict";
const _ = require('lodash');
const mime = require('mime-types');
const xlsx = require('xlsx');
const moment = require('moment');
const axios = require('axios');
const { buhoship, py_util } = require('./../keys');

exports.getDiff = (obj1, obj2) => {
    var allkeys = _.union(_.keys(obj1), _.keys(obj2));
    var difference = _.reduce(allkeys, function (result, key) {
        if (!_.isEqual(obj1[key], obj2[key])) {
            if(obj2[key]) result[key] = obj2[key];
        }
        return result;
    }, {});

    return difference;
}

exports.getDiffArr = (aold, anew) => {
    let hasChanges = false, ch = [];
    let ao1 = _.filter(aold, e => !(_.find(anew, f => f.id == e.id)));
    if(ao1.length > 0)
        ch = _.concat(ch, ao1.map(e => Object.values(_.pick(e,["name"]))[0]));

    let ao2 = _.filter(aold, e => (_.find(anew, f => f.id == e.id && f.cant != e.cant)));
    if(ao2.length > 0)
        ch = _.concat(ch,ao2.map(e => Object.values(_.pick(e,["name"]))[0]));

    let an1 = _.filter(anew, e => !(_.find(aold, f => f.id == e.id)));
    if(an1.length > 0)
        ch = _.concat(ch,an1.map(e => Object.values(_.pick(e,["name"]))[0]));

    if(ch.length > 0) hasChanges = true;
    return { "modified": ch, "hasChanges": hasChanges };
}

exports.getExtension = (type) => {
    if (type && type.length) {
        return mime.extension(type);
    }
    else
        return;
}

exports.getMimeType = (name) => {
    if (name && name.length) {
        return mime.contentType(name);
    }
    else
        return;
}

exports.currentDateTime = () => {
    const d = new Date();
    let month = '' + (d.getMonth() + 1),
        day = '' + d.getDate(),
        year = d.getFullYear(),
        hour = d.getHours(),
        minutes = d.getMinutes(),
        seconds = d.getSeconds();
    if (month.length < 2) 
        month = '0' + month;
    if (day.length < 2) 
        day = '0' + day;
    if (hour.length < 2) 
        hour = '0' + hour;
    if (minutes.length < 2) 
        minutes = '0' + minutes;
    if (seconds.length < 2) 
        seconds = '0' + seconds;
    return [year, month, day, hour, minutes, seconds].join('');
}

exports.sumObjectsByKey = (...objs) => {
    return objs.reduce((a, b) => {
        for (let k in b) {
            if (b.hasOwnProperty(k))
                a[k] = (a[k] || 0) + b[k];
        }
        return a;
    }, {});
}

exports.sheetToJson = (file, name) => {
    const excel = xlsx.read(file);
    const sheets = excel.SheetNames;
    
    for (const s in sheets) {
        if (Object.hasOwnProperty.call(sheets, s)) {
            if (sheets[s].toLowerCase().trim() == name) {
                const sheet = excel.Sheets[sheets[s]];
                return xlsx.utils.sheet_to_json(sheet);
            }
        }
    }

    return;
}

exports.pathSheetToJson = (file, name) => {
    const excel = xlsx.readFile(file);
    const sheets = excel.SheetNames;

    for (const s in sheets) {
        if (Object.hasOwnProperty.call(sheets, s)) {
            if (sheets[s].toLowerCase().trim() == name) {
                const sheet = excel.Sheets[sheets[s]];
                return xlsx.utils.sheet_to_json(sheet);
            }
        }
    }

    return;
}

exports.getOutput = (arr) => {
    let id = 0;
    const a1 = _.find(arr, a => _.isObject(a[0]) && _.keys(a[0]).includes("@output"));
    const a2 = _.find(a1, a => Object.keys(a).find(key => key == "@output"));

    if(a2 && a2["@output"])
        id = a2["@output"];

    return id;
}

exports.getCurrentDate = () =>{
    const currentDate = new Date();
    const formattedDate = currentDate.toLocaleString();
    return formattedDate;
}

exports.getSplitArray = (array, cantidad) => {
    let resultado = [];
    for (var i = 0; i < array.length; i += cantidad) {
        resultado.push(array.slice(i, i + cantidad));
    }
    return resultado;
}

exports.base64FromUrl = async (url) => {
    try {
        const res_img = await axios.get(url, { 
            responseType: "arraybuffer", 
        })
        .then(response => 
            Buffer.from(response.data, 'binary').toString('base64'));
        return res_img;
    } catch (error) {
        return ""
    }
}

exports.readZipFileAndCopyContent = async (filepath) => {
    let arr_of = [];
    const zip = new AdmZip(filepath);
    const zipEntries = zip.getEntries(); // an array of ZipEntry records
    const regex = /[^a-zA-Z0-9-]/g;
    await Promise.all(zipEntries.map(async (zipEntry) => {
        if(!zipEntry.isDirectory) {
            const fileName = zipEntry.name;
            const name_z = fileName.toLowerCase().split(".");
            const ext = name_z[name_z.length - 1];
            const file_data = zip.readFile(zipEntry);
            
            //Here remove the top level directory
            const newFileName = fileName.replace("." + ext,'').replace(regex, '') + "." + ext;  
            const mime = this.getMimeType(newFileName);
            const file_ob = {
                "name": newFileName,
                "mimetype": this.getMimeType(newFileName),
                "data": file_data
            };
            if(mime && ["jpg","png"].includes(ext) && !fileName.startsWith('.'))
                arr_of.push(file_ob);
        }
    }));
    return arr_of;
}

exports.normalizeStr = (name) => {
    const regex = /[^a-zA-Z0-9-]/g;
    return name.replace(regex, '').toLowerCase();
}

exports.arrayToJson = (_columns, _rows) => {
   
    const output = _rows.map((row) => 
        row.map((item, index) => ({ [_columns[index]]: item })).reduce((prev, curr) => ({...prev, ...curr}) , {})
    );
    return output;
}

