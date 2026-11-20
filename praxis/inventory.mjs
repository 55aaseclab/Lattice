import { join } from 'node:path';
export function projectInventory({id,config,working,workspaceId,storage,reminderSpaces,slidesSpaces,polaris,financeMounts,financeProjectName,intelligenceRuntime,locations,add,file,source,safePath,paths,object}) {

      file('文稿、版本、素材与导出', 'directory', config.dataDir);
      for (const path of new Set(paths(slidesSpaces))) file('业务空间文稿', 'sqlite', path);
}
