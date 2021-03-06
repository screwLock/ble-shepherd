/*jslint node: true */
'use strict';

var _ = require('busyman');


var GATTDEFS = require('../defs/gattdefs'),
    Characteristic = require('./characteristic');

function Service (servInfo, perhpheral) {
    var self = this;

	this._original = servInfo.original ? servInfo.original : null;
    this._peripheral = perhpheral;

	this.uuid = servInfo.uuid;
    this.handle = servInfo.startHandle;
    this.startHandle = servInfo.startHandle;
    this.endHandle = servInfo.endHandle;
    this.name = null;
    this.chars = {};

    _.forEach(servInfo.charList, function (charInfo) {
        var char = new Characteristic(charInfo, self);

        self.chars[char.handle] = char;
    });

    if (GATTDEFS.ServUuid.get(_.parseInt(this.uuid))) { 
        this.name = GATTDEFS.ServUuid.get(_.parseInt(this.uuid)).key; 
    } else if (GATTDEFS.ServUuid.get(_.parseInt('0x' + this.uuid.slice(6, 10)))) {
         this.name = GATTDEFS.ServUuid.get(_.parseInt('0x' + this.uuid.slice(6, 10))).key; 
    }
}

Service.prototype.dump = function () {
    var charList,
        index = 0;

    charList = _.map(this.chars, function (char) {
        char._index = index;
        index += 1;
        return char.dump();
    });

    return {
        uuid: this.uuid,
        handle: this.handle,
        startHandle: this.startHandle,
        endHandle: this.endHandle,
        charList: charList
    };
};

module.exports = Service;