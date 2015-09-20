#!/usr/bin/env node
"use strict";
const Lock = require("../index");
const Etcd = require("node-etcd");
const co = require("co");
const Promise = require("bluebird");
const childProcess = require("child_process");
const util = require("util");
const os = require("os");
const _ = require("lodash");
const signal = require("get-signal");
const inspect = _.partialRight(util.inspect, {depth: 2});
const dbg = require("debug");

const argv = require("minimist")(process.argv.slice(2),
  {
    "default": {etcd: "localhost:2379", "id": os.hostname()}
    , boolean: ["verbose"]
    , alias: {e: "etcd", k: "key", i: "id", t: "ttl", h: "help", v: "verbose"}
  });

if(argv.verbose) {
  dbg.enable("etcdlocker:*,etcd-lock:*");
}

const debug = dbg("etcdlocker:main");
const cleanUps = [];

const LOCK_LOST = 2, CHILD_ERROR = 3, LOCK_FAIL = 1;

function getSigNumber(name) {
  try {
    let num = Number(childProcess.execSync(`bash -c "kill -l ${name}"`, {timeout: 1000}));
    return num || signal.getSignalNumber(name.toLocaleUpperCase());
  } catch (e) {
    return signal.getSignalNumber(name.toLocaleUpperCase());
  }
}

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

// run all cleanup functions in sequence, each waiting for the previous to finish and discarding all errors
let runCleanup = _.once(() => {
  return Promise.settle(sequence(cleanUps));
});

_.each(["SIGTERM", "SIGINT", "SIGQUIT"], (sig) => {
  process.on(sig, () => {
    debug(`${sig}. Running cleanup`);
    process.exitCode = 128 + (getSigNumber(sig) || 0);
    runCleanup().then(() => process.exit());
  });
});

let helpTxt = `
  etcdlocker [options] [--] [command]

  Tries to acquire a distributed lock, and when successful, runs a command. The lock will be released when the command
  exits. If you need to supply flags to the command, use --: etcdlocker -i bla -k der -- ls -lah

  Options:
  -h --help                 What you're looking at
  -v --verbose              Output debug information to stderr
  -t --ttl [seconds]        Lock TTL in seconds
  -k --key [key]            etcd key for lock
  -i --id [value]           Node ID. Defaults to host name if not specified
  -e --etcd [host:port]     etcd address. Defaults to localhost:2379

  If etcdlocker loses the lock for whatever reason (key changed from the outside), it will kill the child process and
  exit.

  Exit codes

  Under normal circumstances, etcdlocker will exit with the exit code of the command.  If either etcdlocker or the
  command exit due to a signal, the exit code will be 128 + [signal number], e.g. 143 for SIGTERM. This exit
  code mapping will use bash's kill -l whenever possible to get the code of the signal.

  1: trying to acquire the lock failed, e.g. due to etcd being unavailable
  2: the lock was lost
  3: the child process couldn't either be spawned or killed.
`;

if(argv.help || !(argv.ttl && argv.key && argv.id)) {
  console.log(helpTxt);
  process.exit(0);
}

let cmd = _.head(argv._);
let args = _.tail(argv._);

let hostPort = argv.etcd.split(":");

debug(`Host ${hostPort[0]} port ${hostPort[1]}`);

let etcd = new Etcd(hostPort[0], hostPort[1]);

let lock = new Lock(etcd, argv.key, argv.id, argv.ttl);

co(function* () {
  debug(`Locking ${lock}`);
  let cpDead = false;

  try {
    yield lock.lock();
  } catch(e) {
    console.error(`Couldn't acquire lock: ${inspect(e)}`);
    process.exit(LOCK_FAIL);
  }

  lock.on("error", err => {
    console.error(`Lock error: ${err} (stack ${err.stack})`);

    process.exitCode = LOCK_LOST;
    runCleanup().then(() => process.exit());
  });

  cleanUps.push(() => { // release lock only after everything else is done
    debug(`Unlocking ${lock}`);
    return lock.unlock();
  });

  debug(`Running ${cmd} with arguments ${args.join(" ")}`);
  let cp = childProcess.spawn(cmd, args, {stdio: "inherit"});

  cp.on("error", err => {
    console.error(`Child process error: ${err} (stack ${err.stack})`);
    cpDead = true;
    process.exitCode = CHILD_ERROR;
    runCleanup().then(() => process.exit());
  });

  cp.on("exit", (code, sig) => {
    debug(`Child process ${cp.pid} exited. Exit code ${code}, signal ${sig}`);
    cpDead = true;
    process.exitCode = sig ? 128 + (getSigNumber(sig) || 0) : code;
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