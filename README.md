# etcd-lock

A node package for distributed locks using etcd. It required ES6 support, so node >=4.0.0 should be used.

## Usage

### Instantiation
Use the exported constructor to instantiate new locks. The constructor has the signature `function Lock(etcd, key, id, ttl)`, 
where `etcd` is a `node-etcd` client, `key` is the etcd key to use for locking, `id` is a unique node identifier and 
`ttl` is the TTL of the lock in seconds.

```js
var Lock = require("etcd-lock");
var Etcd = require("node-etcd");
var os = require("os");

var key = "/example/lock"
  , id = os.hostname()
  , ttl = 60 // seconds;

var lock = new Lock(new Etcd(), key, id, ttl);
```

### Locking and unlocking

Each lock instance has the methods `lock()` and `unlock()`, both of which return a promise that will be fulfilled or rejected 
when the action is complete

```js
lock.lock()
  .then(() => { // lock is now locked, 
    console.log("locked");
    /* do stuff here */;
    return lock.unlock();
  })
  .then(() => {
    console.log("unlocked");
  });
```

Note that the example above has no error handling: `lock()` will return a rejected promise if, for example, the etcd cluster
is not reachable.

Calling `lock()` multiple times will simply refresh the lock: you only need to `unlock()` once. The lock will 
automatically refresh itself at intervals of `(lock.ttl*1000) / 2`. To change the refresh interval or TTL after construction, 
change`lock.refreshInterval` or `lock.ttl` *before* calling `lock()`.

Calling `unlock()` when you don't hold the lock will return a rejected promise.

# etcdlocker

etcd-lock comes with a command line tool called etcdlocker (do e.g. `npm install -g etcd-lock` to get it in your path.)

```
  etcdlocker [options] [--] [command]

  Tries to acquire a distributed lock, and when successful, runs a command. The lock will be released when the command
  exits. If you need to supply flags to the command, use --: etcdlocker -i bla -k der -- ls -lah

  Options:
  -h --help                 What you're looking at
  -v --verbose              Output debug information to stderr
  -t --ttl [seconds]        Lock TTL in seconds
  -k --key [key]            etcd key for lock. Will default to the env variable ETCD_LOCK_KEY if not specified
  -i --id [value]           Node ID. Defaults to env ETCD_LOCK_ID, or host name if no env variable is specified
  -e --etcd [host:port]     etcd address. Defaults to ETCD_LOCK_HOST or localhost:2379

  If etcdlocker loses the lock for whatever reason (key changed from the outside), it will kill the child process and
  exit.


  Exit codes

  Under normal circumstances, etcdlocker will exit with the exit code of the command.  If either etcdlocker or the
  command exit due to a signal, the exit code will be 128 + [signal number], e.g. 143 for SIGTERM. This exit
  code mapping will use bash's kill -l whenever possible to get the code of the signal.

  1: trying to acquire the lock failed, e.g. due to etcd being unavailable
  2: the lock was lost
  3: the child process couldn't either be spawned or killed.
  
  
  Example
  
  # Try to acquire lock /test/lock using host name as ID, run mycmd --some --args when lock acquired
  ETCD_LOCK_HOST=etcd:6666 etcdlocker -k /test/lock -t 120 -- mycmd --some --args 
```
