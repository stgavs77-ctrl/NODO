// Disposable DEV-only acceptance assets. Never resolves a production profile.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const dir=path.join(os.homedir(),'Library/Application Support/NODO DEV/workspace/nodo-11-fixtures');fs.mkdirSync(dir,{recursive:true});
fs.copyFileSync(path.join(__dirname,'../assets/nodo-symbol-64.png'),path.join(dir,'image.png'));
fs.writeFileSync(path.join(dir,'note.txt'),'NODO feature acceptance fixture\n');
const rate=16000,count=rate,bytes=Buffer.alloc(44+count*2);bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(count*2,40);for(let i=0;i<count;i++)bytes.writeInt16LE(Math.round(Math.sin(2*Math.PI*440*i/rate)*1500),44+i*2);fs.writeFileSync(path.join(dir,'tone.wav'),bytes);
console.log(dir);
