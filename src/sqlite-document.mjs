import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstatSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const contexts = new AsyncLocalStorage(), queues = new Map();
export const isDatabase = file => /\.db$|\.sqlite(?:3)?$/i.test(file);
export const canonical = value => JSON.stringify(Array.isArray(value) ? value.map(v=>JSON.parse(canonical(v))) : value && typeof value==='object' ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))])) : value);
function safe(file, write) {
  if (typeof file!=='string'||file!==resolve(file)||file.includes('\0')) throw new Error('Database path must be canonical and absolute.');
  for(let path=file;path!==dirname(path);path=dirname(path))try { const info=lstatSync(path); if(info.isSymbolicLink() || path===file&&(!info.isFile()||info.nlink!==1))throw new Error('Database path must not use links.'); }catch(error){if(error.code!=='ENOENT')throw error;}
  if(write)mkdirSync(dirname(file),{recursive:true,mode:0o700});
}
function open(file, write=false) {
  safe(file,write);const mask=process.umask(0o077);let db;
  try { db=new DatabaseSync(file,{readOnly:!write});db.exec('PRAGMA busy_timeout=5000;');if(write){chmodSync(file,0o600);db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS app_database_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT OR IGNORE INTO app_database_meta VALUES('schema_version','1');
    CREATE TABLE IF NOT EXISTS app_documents(space_id TEXT NOT NULL,document_id TEXT NOT NULL,layout TEXT NOT NULL,revision TEXT NOT NULL,byte_size INTEGER NOT NULL,PRIMARY KEY(space_id,document_id));
    CREATE TABLE IF NOT EXISTS app_records(space_id TEXT NOT NULL,document_id TEXT NOT NULL,collection TEXT NOT NULL,entry_key TEXT NOT NULL,ordinal INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(space_id,document_id,collection,entry_key));
    CREATE INDEX IF NOT EXISTS app_records_scope ON app_records(space_id,document_id,collection,ordinal);`);}
    if(db.prepare("SELECT value FROM app_database_meta WHERE key='schema_version'").get()?.value!=='1')throw new Error('Unsupported application database schema.');return db;
  }catch(error){db?.close();throw error;}finally{process.umask(mask);}
}
export async function transaction(file, callback) {
  if(contexts.getStore()?.file===file)return callback();
  const previous=queues.get(file)||Promise.resolve();let release;const turn=new Promise(done=>release=done);const chain=previous.catch(()=>{}).then(()=>turn);queues.set(file,chain);await previous.catch(()=>{});let db;
  try { db=open(file,true);db.exec('BEGIN IMMEDIATE');const context={file,db};const result=await contexts.run(context,callback);context.beforeCommit?.(); db.exec('COMMIT');return result; }
  catch(error){try{db?.exec('ROLLBACK');}catch{}if(error.errcode===5)throw Object.assign(new Error('Application database is busy.'),{status:503,code:'STORE_BUSY'});throw error;}
  finally {db?.close();release();if(queues.get(file)===chain)queues.delete(file);}
}
function connection(file, write, callback) {const active=contexts.getStore();if(active?.file===file)return callback(active.db);const db=open(file,write);try{return callback(db);}finally{db.close();}}
export function readDocument(file,space='local',document='state') {
  return connection(file,false,db=>{const meta=db.prepare('SELECT * FROM app_documents WHERE space_id=? AND document_id=?').get(space,document);if(!meta)throw Object.assign(new Error('Configured database document is missing.'),{code:'DOCUMENT_NOT_FOUND'});
    const fields=JSON.parse(meta.layout).map(([key,kind,scalar])=>{if(kind==='scalar')return[key,scalar];const entries=db.prepare('SELECT entry_key,payload FROM app_records WHERE space_id=? AND document_id=? AND collection=? ORDER BY ordinal').all(space,document,key);return[key,kind==='array'?entries.map(row=>JSON.parse(row.payload)):Object.fromEntries(entries.map(row=>[row.entry_key,JSON.parse(row.payload)]))];});return{value:Object.fromEntries(fields),revision:meta.revision,byteSize:meta.byte_size};});
}
export function hasDocument(file,space='local',document='state') {if(!existsSync(file))return false;return connection(file,false,db=>Boolean(db.prepare('SELECT 1 FROM app_documents WHERE space_id=? AND document_id=?').get(space,document)));}
export async function writeDocument(file,space,document,value,revision,raw) {
  raw??=JSON.stringify(value);value=JSON.parse(raw);revision??=createHash('sha256').update(raw).digest('hex');
  return transaction(file,()=>connection(file,true,db=>{const layout=[];db.prepare('DELETE FROM app_records WHERE space_id=? AND document_id=?').run(space,document);const insert=db.prepare('INSERT INTO app_records VALUES(?,?,?,?,?,?)');
    for(const[key,item]of Object.entries(value)){if(item&&typeof item==='object'){const array=Array.isArray(item);layout.push([key,array?'array':'object']);Object.entries(item).forEach(([entry,record],ordinal)=>insert.run(space,document,key,entry,ordinal,JSON.stringify(record)));}else layout.push([key,'scalar',item]);}
    db.prepare('INSERT INTO app_documents VALUES(?,?,?,?,?) ON CONFLICT(space_id,document_id) DO UPDATE SET layout=excluded.layout,revision=excluded.revision,byte_size=excluded.byte_size').run(space,document,JSON.stringify(layout),String(revision),Buffer.byteLength(raw));return String(revision);}));
}
export function verifyDatabase(file) {return connection(file,false,db=>{const result=db.prepare('PRAGMA integrity_check').get();if(result.integrity_check!=='ok')throw new Error('Application database integrity check failed.');return{integrity:'ok',documents:db.prepare('SELECT COUNT(*) AS n FROM app_documents').get().n,records:db.prepare('SELECT COUNT(*) AS n FROM app_records').get().n};});}
export function sealDatabase(file) {connection(file,true,db=>{db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');});}

export function beforeCommit(file, check) { const context=contexts.getStore(); if(context?.file!==file)throw new Error('A database transaction is required.'); context.beforeCommit=check; }
