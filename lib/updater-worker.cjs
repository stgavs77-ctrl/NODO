'use strict';
const {parentPort,workerData}=require('node:worker_threads');
try{const {unpackVerifiedZip}=require('./updater.cjs');parentPort.postMessage({app:unpackVerifiedZip(workerData.zip,workerData.hash,workerData.folder)});}
catch{parentPort.postMessage({error:'Package integrity or archive validation failed; nothing was installed.'});}
