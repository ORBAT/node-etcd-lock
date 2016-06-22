/**
 * Created by teklof on 22.6.16.
 */
"use strict";

const dbg = require("debug");
const _ = require("lodash");
const util = require("util");
const events = require("events");

const inspect = _.partialRight(util.inspect, {depth: 3});

const debug = dbg("etcdlocker:ipcpinger");
const error = dbg("etcdlocker:ipcpinger:error");

function IPCPinger(childProc, pingInterval, maxWait) {
  events.EventEmitter.call(this);
  this._childProc = childProc;
  this._pingInterval = pingInterval;
  this._maxWait = maxWait;
  if(pingInterval > maxWait) {
    throw new Error(`pingInterval (${pingInterval}) must be less than maxWait (${maxWait})`);
  }
}

util.inherits(IPCPinger, events.EventEmitter);

IPCPinger.prototype.start = function () {
  debug("starting");
  this._childProc.on("message", msg => {
    clearTimeout(this._looper);
    if (!this._running) {
      return;
    }

    if (msg.pong !== this._expect) {
      this._running = false;
      error(
        `got unexpected ping answer from child process. Wanted {ping: ${this._expect}} but got ${JSON.stringify(msg)}`);
      this.emit("error", new Error("Bad ping answer"));
      return;
    }

    clearTimeout(this._timeout);
    debug(`Got pong ${msg.pong}`);

    if (this._running) {
      this._looper = setTimeout(this._sendMsg.bind(this), this._pingInterval);
    }
  });

  this._running = true;
  this._sendMsg();
  return this;
};

IPCPinger.prototype._sendMsg = function () {
  this._expect = _.random(1, 10000000000);
  let msg = {ping: this._expect};

  if(!this._childProc.connected) {
    this.emit("error", new Error("Child not connected?"));
    return;
  }

  this._childProc.send(msg);
  debug(`Sent ping ${this._expect}`);
  this._timeout = setTimeout(() => {
    clearTimeout(this._looper);
    error(`Ping timeout after ${this._maxWait / 1000}s`);
    this._running = false;
    this.emit("error", new Error("Ping timeout"));
  }, this._maxWait);
};

module.exports = IPCPinger;