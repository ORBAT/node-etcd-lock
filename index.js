"use strict";
var events = require("events");
var co = require("co");
var Promise = require("bluebird");
var util = require("util");
var _ = require("lodash");
var inspect = _.partialRight(util.inspect, {depth: 2});
var dbg = require("debug");

function Lock(etcd, key, id, ttl) {
  if (!(etcd && key && id)) {
    throw new Error("Missing constructor argument");
  }
  events.EventEmitter.call(this);
  this._etcd = Promise.promisifyAll(etcd);
  this._key = key;
  this._id = id;
  this._name = `etcd-lock:${key}:${id}`;
  this._dbg = dbg(this._name);
  this.ttl = ttl;
  this._index = -1;
  this.refreshInterval = (ttl * 1000) / 2;
}
util.inherits(Lock, events.EventEmitter);

function LockLostError(key, id, index) {
  Error.captureStackTrace(this, this.constructor);
  this.name = this.constructor.name
  this.message = `Lost lock. Key ${key}, ID ${id}, index ${index}`;
  this.key = key;
  this.id = id;
  this.index = index;
}
util.inherits(LockLostError, Error);

Lock.LockLostError = LockLostError;

Lock.prototype.toString = function toString() {
  return `[${this._name}]`;
};

Lock.prototype._onChange = function _onChange(idx, fn) {
  this._dbg(`Watching for change starting from index ${idx}`);
  let w = this._etcd.watcher(this._key, idx);
  w.on("change", (res) => {
    // if the node's value changed from our ID to something else, run fn
    if (!(res.node && res.node.value && res.node.value == this._id)) {
      this._dbg(`Key changed: ${inspect(res)}`);
      w.removeAllListeners();
      w.stop();
      fn(res);
    }
  });
  w.on("error", (e) => {throw e});
};

Lock.prototype._watchForUnlock = function _watchForUnlock(idx) {
  return new Promise((resolve, reject) => {
    this._dbg(`Watching for unlock starting from index ${idx}`);
    let w = this._etcd.watcher(this._key, idx);
    let solver = (fn) => {
      return (res) => {
        w.removeAllListeners();
        w.stop();
        fn(res);
      }
    };

    w.on("expire", solver(resolve));
    w.on("delete", solver(resolve));
    w.on("compareAndDelete", solver(resolve));

    // somebody's breaking the protocol?
    w.on("set", solver(reject));

    w.on("error", solver(reject));
  }).tap((res) => {
    this._dbg(`Watcher for index ${idx} done. Result ${inspect(res)}`);
  });
};

/*
 > p.reason()
 { [Error: Key already exists]
 cause:
 { snip  },
 isOperational: true,
 errorCode: 105,
 error:
 { errorCode: 105,
 message: 'Key already exists',
 cause: '/s4qs/lock',
 index: 8 } }
 */

Lock.prototype._stopRefresh = function _stopRefresh() {
  if (this._interval) {
    this._dbg("Stopping lock refresh interval");
    clearInterval(this._interval);
    this._interval = null;
  }
};

Lock.prototype._startRefresh = function _startRefresh() {
  if (!this._interval) {
    this._onChange(this._index + 1, (res) => {
      if(this._interval) { // might have been unlocked already
        this._dbg(`We lost the lock. _onChange gave ${inspect(res)}`);
        this.emit("error", new LockLostError(this._key, this._id, this._index));
      }
    });

    this._dbg(`Doing lock refresh at ${this.refreshInterval}ms intervals`);
    this._interval = setInterval(() => {
      this._dbg("Refreshing lock");
      this.lock();
    }, this.refreshInterval);
  }
};

Lock.prototype.unlock = function unlock() {
  this._dbg("Unlocking");
  this._stopRefresh();
  return this._etcd.compareAndDeleteAsync(this._key, this._id);
};

Lock.prototype.lock = co.wrap(function* lock() {
  let ttl = this.ttl;

  this._dbg("Trying to lock");

  let res = yield this._etcd.getAsync(this._key).catch((e) => {
    if (e.errorCode != 100) { // key not found
      throw e;
    }
    return null;
  });

  this._dbg(`key contained ${inspect(res)}`);

  /*
   { action: 'get',
   node:
   { key: '/s4qs/lock',
   value: 'test1',
   expiration: '2015-09-18T19:20:03.670116086Z',
   ttl: 27,
   modifiedIndex: 27,
   createdIndex: 27 } },
   { 'content-type': 'application/json',
   'x-etcd-cluster-id': '7e27652122e8b2ae',
   'x-etcd-index': '27',
   'x-raft-index': '28885',
   'x-raft-term': '2',
   date: 'Fri, 18 Sep 2015 19:19:37 GMT',
   'content-length': '153' }
   */

  if (res) { // a value existed
    let node = res[0].node;
    if (node.value == this._id) { // it's our key, just refresh the TTL
      try {
        this._dbg(`We already have the lock with TTL ${node.ttl}, refreshing with TTL ${ttl}`);
        let res = yield this._etcd.setAsync(this._key, this._id, {ttl: ttl, prevValue: this._id});
        this._index = res[0].node.modifiedIndex;
        this._startRefresh();
        this._dbg(`Refresh result ${inspect(res)}`);
        return this;
      } catch (e) { // somebody got between us and the refresh? Throw an error
        this._dbg(`Failed to refresh node ${inspect(node)}: ${inspect(e)}, waiting`);
        this.emit("error",new LockLostError(this._key, this._id, this._index));
      }
    } else {
      this._dbg(`Key already locked by ${node.value}, waiting`);
      return this._watchForUnlock(node.modifiedIndex + 1).then(this.lock.bind(this));
    }
  }

  // no value there, try to lock
  // try to set _key to _id with prevExist=false. If it fails, watch _key using prev index and then try again
  try {
    this._dbg(`Locking with TTL ${ttl}`);
    let res = yield this._etcd.setAsync(this._key, this._id, {ttl: ttl, prevExist: false});
    this._index = res[0].node.modifiedIndex;
    this._startRefresh();
    this._dbg(`Set result ${inspect(res)}`);
    return this;
  } catch (e) {
    if (e.errorCode == 105) { // key exists: someone was faster than us. Wait until they unlock and try again
      this._dbg("Somebody beat us to it, waiting");
      return this._watchForUnlock(e.error.index + 1).then(this.lock.bind(this));
    }

    throw e; // dunno what happened
  }
});

module.exports = Lock;

