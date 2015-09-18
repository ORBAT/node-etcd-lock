/**
 * Created by teklof on 18.9.15.
 */
var co = require("co");
var Etcd = require("node-etcd");
var Lock = require("./")
var etcd = new Etcd();