'use strict';

var Q = require('q'),
    _ = require('lodash'),
    util = require('util'),
    process = require('process'),
    async = require('async-kit'),
    EventEmitter = require('events').EventEmitter,
    ccbnp = require('cc-bnp');

var nwkScanner = require('./management/nwkScanner'),
    devmgr = require('./management/devmgr'),
    bleutil = require('../util/bleutil'),
    GATTDEFS = require('../defs/gattdefs'),
    servConstr = require('./service/bleServConstr');

var scanEmptyCount = 0;

function BShepherd () {
    this._permitState = 'off';
    this._permitTimer = null;
    this._connSpinLock = 'off';
    this._syncSpinLock = 'off';
    this._connNum = 0;

    this.bleCentral = null;

    this.app = function () {};
    this.appInit = function () {};
    this.setScanRule = function () {};
    this.blacklist = [];
}

util.inherits(BShepherd, EventEmitter);
var manager = new BShepherd();

BShepherd.prototype.start = function (bleApp, spCfg) {
    var self = this;

    if (!_.isPlainObject(spCfg) || _.isUndefined(spCfg.path)) {
        throw new Error('spConfig must be an object and should have path property');
    }

    ccbnp.init(spCfg, 'central').then(function () {
        if (_.isFunction(bleApp))
            self.app = bleApp;
    });
    

    this._onSigninBind = this._onSignin.bind(this);
    process.on('SIGINT', this._onSigninBind);
    process.on('asyncExit', this._onAsyncExit.bind(this));

    return this;
};

BShepherd.prototype.setNwkParams = function (type, setting, callback) {
    var deferred = Q.defer(),
        cmdName;

    if (type === 'scan') {
        cmdName = 'setScanParams';
    } else if (type === 'link') {
        cmdName = 'setLinkParams';
    }

    if (!cmdName) {
        throw new TypeError('type must be a string of scan or link');
    }
    if (!_.isPlainObject(setting)) {
        throw new TypeError('setting must be an object.');
    }

    nwkScanner[cmdName](setting).then(function (result) {
        deferred.resolve(result);
    }).fail(function (err) {
        deferred.reject(err);
    }).done();

    return deferred.promise.nodeify(callback);
};

BShepherd.prototype.permitJoin = function (duration) {
    var self = this;

    if (!_.isNumber(duration)) { throw new Error('duration must be a number'); }

    if (this._permitTimer) {
        clearTimeout(self._permitTimer);
        self._permitTimer = null;
    }

    this._permitState = 'on';
    this._permitTimer = setTimeout(function () {
        self._permitState = 'off';
        clearTimeout(self._permitTimer);
        self._permitTimer = null;
        self.emit('IND', {type: 'NWK_PERMITJOIN', data: 0});
    }, duration * 1000);

    this.emit('IND', {type: 'NWK_PERMITJOIN', data: duration});

    return this;
};

BShepherd.prototype.command = function (subGroup, cmd, argInst, callback) {
    var deferred = Q.defer();

    ccbnp[subGroup][cmd](argInst, callback).then(function (result) {
        deferred.resolve(result);
    }).fail(function (err) {
        deferred.reject(err);
    }).done();

    return deferred.promise.nodeify(callback);
};

BShepherd.prototype.find = function (addrOrHdl) {
    return devmgr.findDev(addrOrHdl);
};

BShepherd.prototype.regGattDefs = function (type, regObjs) {
    var enumName,
        enumNewMem = {};

    if (type === 'service') {
        enumName = 'ServUuid'; 
    } else if (type === 'characteristic') { 
        enumName = 'CharUuid'; 
    } else {
        throw new Error('type must be service or characteristic.');
    }

    if (!_.isObject(regObjs)) { throw new TypeError('regObjs must be an object or an array'); }

    _.forEach(regObjs, function (regObj) {
        if (_.isString(regObj.uuid)) { regObj.uuid = _.parseInt(regObj.uuid, 16); }

        if (GATTDEFS[enumName].get(regObj.name)) { 
            throw new Error(_.capitalize(type) + ' name of ' + regObj.name + ' is conflict with GATT specifications.');
        } 
        if (GATTDEFS[enumName].get(regObj.uuid)) { 
            throw new Error(_.capitalize(type) + ' uuid of ' + regObj.uuid + ' is conflict with GATT specifications.');
        }


        enumNewMem[regObj.name] = regObj.uuid;
        GATTDEFS[enumName] = bleutil.addEnumMember(enumNewMem, GATTDEFS[enumName]);

        if (type === 'characteristic' && !_.isEmpty(regObj.params) && !_.isEmpty(regObj.types)) {
            try {
                ccbnp.regChar(regObj);
            } catch (err) {
                throw new Error(_.capitalize(type) + ' uuid of ' + regObj.uuid + ' is conflict with GATT specifications.');
            }
        }
    }); 

    return this;
};

BShepherd.prototype.addLocalServ = function (servInfo, callback) {
    var deferred = Q.defer(),
        serv;

    if (!servInfo || !_.isPlainObject(servInfo)) { 
        throw new TypeError('servInfo must be an object'); 
    }
    if (!_.isArray(servInfo.charsInfo)) { 
        throw new TypeError('servInfo.charsInfo must be an array.'); 
    }
    if (!_.isString(servInfo.uuid) || !_.startsWith(servInfo.uuid, '0x')) {  
        throw new TypeError('servInfo.uuid must be a string and start with 0x');
    }
    
    serv = new servConstr(servInfo.uuid, servInfo.charsInfo, servInfo.name);

    if (_.indexOf(this.bleCentral.servs, serv) !== -1) {
        deferred.reject(new Error('Local service already exist. You need to delete the old before add a new.'));
    } else {
        this.bleCentral.regServ(serv).then(function (result) {
            serv._isRegister = true;
            ccbnp.regUuidHdlTable(65534, serv.expUuidHdlTable());
            console.log('>> Local service registered!');
            deferred.resolve(result);
        }).fail(function (err) {
            deferred.reject(err);
        }).done();
    }  

    return deferred.promise.nodeify(callback);
};

BShepherd.prototype._regUuidHdlTable = function () {
    var table = {};

    if (_.size(devmgr.bleDevices) <= 1) { return; }
    _.forEach(devmgr.bleDevices, function (periph) {
        if (periph.role === 'peripheral') {
            _.forEach(periph.servs, function (serv) {
                _.forEach(serv.chars, function (char) {
                    table[char.hdl] = char.uuid;
                });
            });
            if (_.isNumber(periph.connHdl)) {
                ccbnp.regUuidHdlTable(periph.connHdl, table);
            }
        }
    });
};

BShepherd.prototype._onSignin = function () {
    var sigIntListeners = process.listeners('SIGINT');

    if (sigIntListeners[sigIntListeners.length - 1] === this._onSigninBind) {
        async.exit();
    }
};

BShepherd.prototype._onAsyncExit = function (code, time, callback) {
    var self = this,
        disconnPeriphs = [];

    this.permitJoin(0);
    nwkScanner.cancelScan();
    _.forEach(devmgr.bleDevices, function (periph) {
        if (periph.state === 'online') {
            disconnPeriphs.push(periph.disconnect.bind(periph));
        }
    });

    bleutil.seqResolveQFuncs(disconnPeriphs).then(function () {
        ccbnp.hci.resetSystem(0);
    });
};

/*************************************************************************************************/
/*** Event Listeners                                                                           ***/
/*************************************************************************************************/
ccbnp.on('ready', initDoneHdlr);
ccbnp.on('ind', ccBnpEvtHdlr);
nwkScanner.on('NS:IND', scanHdlr);

/*************************************************************************************************/
/*** Event Handlers                                                                            ***/
/*************************************************************************************************/
function initDoneHdlr (msg) {
    var central,
        onlineNum = 0,
        periphCount = 0,
        connectedCount = 0,
        connectPeriphFuncs = [],
        connPeriphs = [],
        pausePeriphs = [];

    console.log('>> Central has completed initialization');
    try {
        central = devmgr.newDevice('central', msg.devAddr);
        manager.bleCentral = central;
        devmgr.bleDevices.push(central); 
    } catch (e) {
        console.log('Can not create central with error: ' + e + '.');
    }

    manager.appInit();
    nwkScanner.getScanParams().then(function () {
        return nwkScanner.setLinkParams({});
    }).then(function () {
        return nwkScanner.setScanParams({time: 3000});
    }).then(function () {
        console.log('>> Loading devices from database.');
        return devmgr.loadPeriphs();
    }).then(function (periphs) {
        console.log('>> Asynchrnously connect devices in database.');
        _.forEach(periphs, function (periph) {
            connectPeriphFuncs.push(function () {
                var deferred = Q.defer();
               
                periph.connect().then(function () {
                    manager.on('IND', function (msg) {
                        if (msg.type === 'DEV_INCOMING' && msg.data === periph.addr) {
                            if (!_.includes(connPeriphs, periph.addr)) {
                                connPeriphs.push(periph.addr);
                            }
                            
                            periphCount += 1;
                            manager.removeAllListeners('SYNC_ERROR:' + periph.addr);
                            if (_.size(connPeriphs) === 3 && periphCount !== _.size(periphs)) { 
                                devmgr.pausePeriph().done(function (periphAddr) {
                                    connPeriphs.splice(_.indexOf(connPeriphs, periphAddr), 1);
                                    pausePeriphs.push(periphAddr);
                                    deferred.resolve();
                                }, function (err) {
                                    deferred.reject(err);
                                }); 
                            } else {
                                deferred.resolve();
                            }
                        }
                    });

                    manager.once('SYNC_ERROR:' + periph.addr, function () {
                        removeDev(deferred, periph);
                    });
                }).fail(function (err) {
                    removeDev(deferred, periph);
                }).done();
                return deferred.promise;
            });
        });
        
        return bleutil.seqResolveQFuncs(connectPeriphFuncs);
    }).then(function () {
        manager.removeAllListeners('IND');
        manager._regUuidHdlTable();
        manager.permitJoin(60);
        nwkScanner.scan();
        manager.app();
        notifPeriphState(connPeriphs, pausePeriphs);
        console.log('>> Starting bleApp.');
    }).fail(function (err) {
        console.log('Problem occurs when starting central');
        console.log(err);
    }).done();
}

function scanHdlr (periphsInfo) {
    var periph,
        discPeriphNum = 0,
        oldPermitState = manager._permitState;

    _.forEach(periphsInfo, function (periphInfo) {
        if (oldPermitState === 'on') {
            periph = devmgr.newDevice('peripheral', periphInfo.addr, periphInfo.addrType);
        } else {
            periph = manager.find(periphInfo.addr);
        }

        if (periph && periph.state !== 'pause') {
            if (!_.includes(manager.blacklist, periph.addr)) {
                discPeriphNum += 1;
                connectPeriph(periph);
            }
        }
    });

    if (discPeriphNum !== 0) {
        manager.once('CONNECT_OVER', function () {
            if (oldPermitState === 'off') {
                scanEmptyCount = 0;
                applyScanRule(scanEmptyCount);
            } else if (manager._permitState === 'on') {
                nwkScanner.scan();
            }
        });
    } else {
        if (oldPermitState === 'off') {
            scanEmptyCount += 1;
            applyScanRule(scanEmptyCount);
        } else if (manager._permitState === 'on') {
            nwkScanner.scan();
        }
    }
}

function ccBnpEvtHdlr (msg) {
    var periph;

    try {
        if (msg.type === 'linkEstablished') {
            periph = devmgr.findDev(msg.data.addr);
        } else if (msg.type !== 'passkeyNeeded' && msg.type !== 'attReq') {
            periph = devmgr.findDev(msg.data.connHandle);
            if (!periph) { return; }
        }
    } catch (e) {
        console.log('Can not find a device when receive ' + msg.type + 'event with error: ' + e + '.');
    }

    switch (msg.type) {
        case 'linkEstablished':
            if (msg.data.addr === '0x000000000000') { break; }
            manager._connNum += 1;
            manager.emit('IND', {type: 'DEV_ONLINE', data: msg.data});
            setTimeout(function () { processLinkEst(msg.data, periph); }, 10);
            break;
        case 'linkTerminated':
            manager._connNum -= 1;
            setTimeout(function () { processLinkTerm(msg.data, periph); }, 10);
            break;
        case 'linkParamUpdate':
            processLinkParamUpdate(msg.data, periph);
            break;
        case 'attNoti':
        case 'attInd':
            processAttrInd(msg.type, msg.data, periph);
            break;
        case 'authenComplete':
            processAuthenComplete(msg.data, periph);
            break;
        case 'passkeyNeeded':
            manager.emit('IND', {type: 'PASSKEY_NEED', data: msg.data});
            break;
        case 'bondComplete':
            processbBondComplete(msg.type, periph);
            break;
        case 'attReq':
            manager.bleCentral.processAttMsg(msg.data).fail(function (err) {
                manager.emit('IND', {type: 'LOCAL_SERV_ERR', data: {evtData: msg.data, err: err}});
            }).done();
            break;
        default:
            break;
    }
}

/*************************************************************************************************/
/*** ccBnp Event Handler                                                                       ***/
/*************************************************************************************************/
function processLinkEst (msg, periph) {
    var rebuildFlag = false;

    if (!periph) {
        try {
            periph = devmgr.newDevice('peripheral', msg.addr, 0);
        } catch (e) {
            console.log('Can not create a device with error: ' + e + '.');
        }
    }

    if (periph.state === 'disc') { rebuildFlag = true; }
    periph.connHdl = msg.connHandle;
    periph.linkParams = {
        interval: msg.connInterval, 
        latency: msg.connLatency, 
        timeout: msg.connTimeout
    };

    if (periph.state !== 'pause') {
        syncPeriph(periph, rebuildFlag);
    } else {
        periph.state = 'online';
    }
}

function processLinkTerm (msg, periph) {
    periph.connHdl = null;
    if (periph.state === 'pause' || periph.state === 'disc') { return; }
    periph.state = 'offline';
    console.log('Device: ' + periph.addr + ' leave the network.');
    manager.emit('IND', {type: 'DEV_LEAVING', data: periph.addr});
}

function processLinkParamUpdate (msg, periph) {
    periph.linkParams = {
        interval: msg.connInterval, 
        latency: msg.connLatency,
        timeout: msg.connTimeout
    };     
}

function processAttrInd (type, msg, periph) {
    _.forEach(periph.servs, function (serv) {
        _.forEach(serv.chars, function (char) {
            if (char.hdl === msg.handle) {
                char.indUpdate(msg.value);
                char.processInd(msg.value);
            }
        });
    });
    if (type === 'attInd') {
        ccbnp.att.handleValueCfm(msg.connHandle);
    }
}

function processAuthenComplete (msg, periph) {
    if (msg.ltk !== new Buffer(16).fill(0)) {
        try {
            if (!periph.sm) { periph.createSecMdl(msg); }
            periph.sm.state = 'encrypted';
            periph.sm.update(msg);
        } catch (e) {
            console.log('Can not create security model with error: ' + e + '.');
        }
    }
}

function processbBondComplete (msg, periph) {
    periph.sm.bond = 'true';
    periph.sm.status = 'encrypted';
}

/*************************************************************************************************/
/*** Private Function                                                                          ***/
/*************************************************************************************************/
function connectPeriph (periph) {
    var timeout = 0;

    if (manager._connSpinLock === 'on') {
        if (!_.find(devmgr._discDevs, {addr: periph.addr})) {
            devmgr._discDevs.push(periph);
        }
    } else if (manager._connNum < 3) {
        manager._connSpinLock = 'on';
        periph.connect().fail(function (err) {
            console.log('Device: ' + periph.addr + ' connect error with ' + err);
        }).finally(function () {
            manager._connSpinLock = 'off';
            if (!_.isEmpty(devmgr._discDevs)) {
                process.nextTick(function () {
                    connectPeriph(devmgr._discDevs.shift());
                });
            } else {
                manager.emit('CONNECT_OVER');
            }
        }).done();
    } else {
        devmgr.pausePeriph().then(function (periphAddr) {
            manager.emit('IND', {type: 'DEV_PAUSE', data: periphAddr});
            connectPeriph(periph);
        }).fail(function (err) {
            setTimeout(function () {
                connectPeriph(periph);
            }, 3000);
        }).done();
    }
}

function syncPeriph (periph, flag) {
    function getPeriphInfo (rebuildFlag) {
        if (rebuildFlag === true) {
            return periph.getServs().then(function () {
                return periph.save();
            });
        } else {
            return periph.update();
        }
    }

    if (manager._syncSpinLock === 'off') {
        manager._syncSpinLock = 'on';
        getPeriphInfo(flag).then(function () {
            periph.state = 'online';
            console.log('Device: ' + periph.addr + ' join the network.');
            manager.emit('IND', {type: 'DEV_INCOMING', data: periph.addr});
        }).fail(function (err) {
            console.log('Device: ' + periph.addr + ' update GATT information failure with error: ' + err +'.');
            manager.emit('SYNC_ERROR:' + periph.addr);
            periph.disconnect();
        }).finally(function () {
            manager._syncSpinLock = 'off';
            if (!_.isEmpty(devmgr._syncDevs)) {
                process.nextTick(function () {
                    var nextPeriphInfo = devmgr._syncDevs.shift();
                    syncPeriph(nextPeriphInfo.periph, nextPeriphInfo.flag);
                });
            }
        }).done();
    } else {
        devmgr._syncDevs.push({periph: periph, flag: flag});
    }
}

function removeDev (deferred, periph) {
    periph.removeFromDb().done(function () {
        var bleDevs = devmgr.bleDevices;
        bleDevs.splice(_.indexOf(bleDevs, periph), 1);
        deferred.resolve();
    }, function (err) {
        deferred.reject(err);
    });
}

function notifPeriphState(connPeriphs, pausePeriphs) {
    _.forEach(connPeriphs, function (periphAddr) {
        manager.emit('IND', {type: 'DEV_INCOMING', data: periphAddr});
    });

    _.forEach(pausePeriphs, function (periphAddr) {
        manager.emit('IND', {type: 'DEV_PAUSE', data: periphAddr});
    });
}

function applyScanRule (times) {
    var interval = 3000;

    if (!_.isFunction(manager.setScanRule)) {
        return;
    }

    interval = manager.setScanRule(times) || interval;
    setTimeout(function () {
        nwkScanner.scan();
    }, interval);
}

module.exports = manager;