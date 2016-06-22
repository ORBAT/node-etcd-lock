#!/usr/bin/env node
"use strict";
const dbg = require("debug");
const Lock = require("../index");
const Etcd = require("node-etcd");
const co = require("co");
const Promise = require("bluebird");
const childProcess = require("child_process");
const util = require("util");
const os = require("os");
const _ = require("lodash");
const signal = require("get-signal");
const inspect = _.partialRight(util.inspect, {depth: 3});

const argv = require("minimist")(process.argv.slice(2),
  {
    "default": {
      etcd: process.env.ETCD_LOCK_HOST || "localhost:2379"
      , id: process.env.ETCD_LOCK_ID || os.hostname()
      , key: process.env.ETCD_LOCK_KEY
      , node: !!process.env.ETCD_CHILD_IS_NODE
      , ttl: process.env.ETCD_LOCK_TTL || 0
      , refresh: process.env.ETCD_LOCK_REFRESH || 0
    }
    , boolean: ["verbose", "node"]
    , alias: {e: "etcd", k: "key", i: "id", t: "ttl", h: "help", v: "verbose", r: "refresh", n: "node"}
  });

if(argv.verbose) {
  dbg.enable("etcdlocker:*,etcd-lock:*,etcdlocker:ipcpinger,etcdlocker:ipcpinger:error");
}

const IPCPinger = require("./ipcpinger");

const debug = dbg("etcdlocker:main");
const error = dbg("etcdlocker:main:error");
const cleanups = [];

const LOCK_LOST = 2, CHILD_ERROR = 3, LOCK_FAIL = 1, IPC_FAIL = 4;

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
  return Promise.settle(sequence(cleanups)).tap(() => debug("cleanup done"));
});

_.each(["SIGTERM", "SIGINT", "SIGQUIT"], (sig) => {
  process.on(sig, () => {
    debug(`${sig}. Running cleanup`);
    process.exitCode = 128 + (getSigNumber(sig) || 0);
    runCleanup().then(() => process.exit());
  });
});

const helpTxt = `
  etcdlocker [options] [--] [command]

  Tries to acquire a distributed lock, and when successful, runs a command. The lock will be released when the command
  exits. If you need to supply flags to the command, use --: etcdlocker -i bla -k der -- ls -lah

  Options:
  -h --help                 what you're looking at
  
  -e --etcd [host:port]     etcd address. Defaults to ETCD_LOCK_HOST or localhost:2379
  
  -i --id [value]           node ID. Defaults to env ETCD_LOCK_ID, or host name if no env variable is specified
  
  -k --key [key]            etcd key for lock. Will default to the env variable ETCD_LOCK_KEY if not specified
  
  -n --node                 assume that the command is a Node.js module. This will start the child process with
                            child_process.fork() and send ping messages at the same rate as it'll refresh the lock.
                            The sent ping is {ping: somevalue}, and the expected reply is {pong: somevalue}. Child
                            processes have at most TTL seconds to reply.
                            
  -r --refresh [seconds]    lock refresh period in seconds. Defaults to TTL / 2. Can also be specified with ETCD_LOCK_REFRESH
  
  -t --ttl [seconds]        lock TTL in seconds. Can also be specified with ETCD_LOCK_TTL
  
  -v --verbose              output debug information to stderr

  If etcdlocker loses the lock for whatever reason (e.g. key was changed "from the outside"), it will kill the child process and
  exit.


  Exit codes

  Under normal circumstances, etcdlocker will exit with the exit code of the command.  If either etcdlocker or the
  command exit due to a signal, the exit code will be 128 + [signal number], e.g. 143 for SIGTERM. This exit
  code mapping will use bash's kill -l whenever possible to get the code of the signal.

  1: trying to acquire the lock failed, e.g. due to etcd being unavailable
  2: the lock was lost
  3: the child process couldn't either be spawned or killed
  4: problem with IPC pings with Node.js child processes


  Example

  # Try to acquire lock /test/lock using host name as ID, run mycmd --some --args when lock acquired
  ETCD_LOCK_HOST=etcd:6666 etcdlocker -k /test/lock -t 120 -- mycmd --some --args
`;

if(argv.help || !(argv.ttl && argv.key && argv.id)) {
  console.log(`Missing argument: ttl present: ${!argv.ttl}. key present: ${!argv.key}. id present: ${!argv.id}`);
  console.log(helpTxt);
  process.exit(0);
}

if(!argv.refresh) {
  argv.refresh = (argv.ttl * 1000) / 2;
} else {
  argv.refresh *= 1000;
}

let cmd = _.head(argv._);
let args = _.tail(argv._);

let hostPort = argv.etcd.split(":");

debug(`Host ${hostPort[0]} port ${hostPort[1]}`);

let etcd = new Etcd(hostPort[0], hostPort[1]);

let lock = new Lock(etcd, argv.key, argv.id, argv.ttl);
lock.refreshInterval = argv.refresh;

let spawnFunc = argv.node ? childProcess.fork : childProcess.spawn;

co(function* () {
  debug(`Locking ${lock}`);
  let cpDead = false;

  try {
    yield lock.lock();
  } catch(e) {
    error(`Couldn't acquire lock: ${inspect(e)}`);
    process.exit(LOCK_FAIL);
  }

  lock.once("error", err => {
    error(`Lock error: ${err} (stack ${err.stack})`);

    process.exitCode = LOCK_LOST;
    runCleanup().then(() => process.exit());
  });

  cleanups.unshift(() => Promise.resolve(lock.removeAllListeners("error")));

  cleanups.push(() => { // release lock only after everything else is done
    debug(`Unlocking ${lock}`);
    return lock.unlock();
  });

  debug(`Running ${cmd} with arguments ${args.join(" ")}`);
  let cp = spawnFunc(cmd, args, {stdio: "inherit"});

  cleanups.unshift(() => {
    if(!cpDead) {
      debug(`Killing child process ${cp.pid}`);
      cp.removeAllListeners("exit");
      return new Promise((res) => {
        cp.kill("SIGTERM");
        cp.on("exit", res);
      }).tap(() => debug("Child process dead")).timeout(30000);
    }
    return Promise.resolve();
  });

  var pinger;

  if(argv.node) {
    try { pinger = new IPCPinger(cp, argv.refresh, argv.ttl*1000);} catch (e) {
      error(`Couldn't start IPC pinger: ${e}`);
      process.exitCode = IPC_FAIL;
      runCleanup().then(process.exit);
      return;
    }

    cleanups.unshift(() => Promise.resolve(pinger.removeAllListeners("error")));

    pinger.once("error", (err) => {
      error(`IPCPinger emitted an error: ${err}. Bailing out`);
      runCleanup().then(process.exit);
    });

    pinger.start();
  }

  cp.once("error", err => {
    error(`Child process error: ${err} (stack ${err.stack})`);
    cpDead = true;
    process.exitCode = CHILD_ERROR;
    runCleanup().then(process.exit);
  });
  
  cp.once("exit", (code, sig) => {
    debug(`Child process ${cp.pid} exited. Exit code ${code}, signal ${sig}`);
    cpDead = true;
    process.exitCode = sig ? 128 + (getSigNumber(sig) || 0) : code;
    runCleanup().then(process.exit);
  });

  cleanups.unshift(() => Promise.resolve(cp.removeAllListeners("error", "exit")));

}).catch((e) => {
  error(`Uncaught error, welp. "${e}"`);
  runCleanup().then(process.exit);
});