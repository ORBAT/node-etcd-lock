#!/usr/bin/env node
"use strict";
var Lock = require("../index");
var Etcd = require("node-etcd");
var co = require("co");
var Promise = require("bluebird");
var spawn = require("child_process").spawn;
var util = require("util");
var _ = require("lodash");
var inspect = _.partialRight(util.inspect, {depth: 2});
var dbg = require("debug");
var debug = dbg("etcdlocker:main");

var cleanUps = [];

function sequence(fns) {
  return Promise.reduce(fns, (acc, fn) => {
    return fn()
      .catch(_.identity)
      .then((res) => {
        acc.push(res);
        return acc;
      });
  }, []);
}

// run all cleanup functions in sequence, each waiting for the previous to finish
var runCleanup = _.once(() => {
  return Promise.settle(sequence(cleanUps));
});

_.each(["SIGTERM", "SIGINT"], (sig) => {
  process.on(sig, () => {
    debug(`${sig}. Total of ${cleanUps.length} cleanup functions found`);
    runCleanup().then(() => process.exit());
  });
});

var argv = require("minimist")(process.argv.slice(2),
  {
    "default": {etcd: "localhost:2379"}
    , alias: {e: "etcd", k: "key", i: "id", t: "ttl", h: "help"}
  });

var helpTxt = `
  etcdlocker [options] [--] [command]

  Tries to acquire a distributed lock, and when successful, runs a command. The lock will be released when the command
  exits.

  Options:
  -h --help                 Duh
  -t --ttl [seconds]        Lock TTL in seconds
  -k --key [key]            etcd key for lock
  -i --id [value]           Node ID
  -e --etcd [host:port]     etcd address. Defaults to localhost:2379
`;

if(argv.help || !(argv.ttl && argv.key && argv.id)) {
  console.log(helpTxt);
  process.exit(0);
}

var cmd = _.head(argv._);
var args = _.tail(argv._);

var hostPort = argv.etcd.split(":");

debug(`Host ${hostPort[0]} port ${hostPort[1]}`);

var etcd = new Etcd(hostPort[0], hostPort[1]);

var lock = new Lock(etcd, argv.key, argv.id, argv.ttl);

co(function* () {
  debug(`Locking ${lock}`);
  var cpDead = false;
  try {
    yield lock.lock();
  } catch(e) {
    console.error(`Couldn't acquire lock: ${inspect(e)}`);
    process.exit(1);
  }

  lock.on("error", err => {
    console.error(`Lock error: ${err} (stack ${err.stack})`);
    runCleanup().then(() => process.exit(1));
  });

  cleanUps.push(() => {
    debug(`Unlocking ${lock}`);
    return lock.unlock();
  });

  debug(`Running ${cmd} with arguments ${args.join(" ")}`);
  var cp = spawn(cmd, args, {stdio: "inherit"});

  cp.on("error", err => {
    console.error(`Child process error: ${err} (stack ${err.stack})`);
    process.exit(1);
  });

  cp.on("exit", () => {
    debug(`Child process ${cp.pid} exited`);
    cpDead = true;
    runCleanup().then(() => process.exit());
  });

  cleanUps.unshift(() => {
    if(!cpDead) {
      debug(`Killing child process ${cp.pid}`);
      cp.removeAllListeners("exit");
      return new Promise((res) => {
        cp.kill("SIGTERM");
        cp.on("exit", res);
      }).tap(() => debug("Child process dead"));
    }
    return Promise.resolve();
  });
});