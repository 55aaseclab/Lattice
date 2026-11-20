import { hasDocument, writeDocument, transaction, sealDatabase } from '../src/sqlite-document.mjs';
export async function initializeDatabase({file,spaceId='local',value=null}) { if(value===null){await transaction(file,()=>{});return;}if(!hasDocument(file,spaceId))await transaction(file,async()=>{if(!hasDocument(file,spaceId))await writeDocument(file,spaceId,'state',value,value.revision);});}
