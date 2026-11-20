import { readFile, writeFile, rename, rm, lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, dirname, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { canonical, writeDocument, readDocument, verifyDatabase, sealDatabase } from './sqlite-document.mjs';
export async function migrateDatabase({sources,database,receipt,validate,revisionOf=(value,source,hash)=>source.revision??value._business?.revision??value.revision??hash,readOnly=false,writersStopped=false}) {
  if(!writersStopped)throw new Error('Stop all source and destination writers before conversion.');
  for(const path of[database,receipt])if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path)throw new Error('Use explicit canonical database and receipt paths.');
  if(await lstat(receipt).catch(error=>{if(error.code==='ENOENT')return null;throw error;}))throw new Error('Receipt already exists; nothing was changed.');
  if(!Array.isArray(sources)||!sources.length)throw new Error('Explicit existing source records are required.');
  if(await lstat(database).catch(error=>{if(error.code==='ENOENT')return null;throw error;}))throw new Error('Destination database already exists; nothing was replaced.');
  await mkdir(dirname(database),{recursive:true,mode:0o700});if(await realpath(dirname(database))!==dirname(database))throw new Error('Destination directory must be canonical.');
  const temporary=database+'.stage-'+randomUUID(),seen=new Set(),proof=[];
  try{
    for(const source of sources){const{file,spaceId='local',documentId='state'}=source;if(typeof file!=='string'||!isAbsolute(file)||resolve(file)!==file||await realpath(file)!==file)throw new Error('Source must be a canonical existing file.');if(![spaceId,documentId].every(v=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(v)))throw new Error('Invalid database resource identity.');const identity=JSON.stringify([spaceId,documentId]);if(seen.has(identity))throw new Error('Duplicate source resource.');seen.add(identity);
      const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>128*1024*1024)throw new Error('Source must be a bounded regular file.');const raw=await readFile(file,'utf8'),value=JSON.parse(raw);await validate(value,source);const hash=createHash('sha256').update(raw).digest('hex');await writeDocument(temporary,spaceId,documentId,value,revisionOf(value,source,hash),raw);const imported=readDocument(temporary,spaceId,documentId);if(canonical(imported.value)!==canonical(value))throw new Error('Converted data differs from the original.');if(createHash('sha256').update(await readFile(file)).digest('hex')!==hash)throw new Error('Source changed during conversion.');proof.push({spaceId,documentId,sourceHash:hash,sourceBytes:info.size,revision:imported.revision});
    }
    const integrity=verifyDatabase(temporary);if(readOnly)sealDatabase(temporary);await rename(temporary,database);
    const result={schemaVersion:1,convertedAt:new Date().toISOString(),database,originalsRetained:true,...integrity,sources:proof};await writeFile(receipt,JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});return result;
  }catch(error){for(const suffix of['','-wal','-shm'])await rm(temporary+suffix,{force:true});throw error;}
}
