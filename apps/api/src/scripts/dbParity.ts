import { runSchemaParity } from "../services/databaseMigrationFoundation";
const r=runSchemaParity(); console.log(JSON.stringify(r,null,2)); if(r.blocking.length) process.exit(1);
