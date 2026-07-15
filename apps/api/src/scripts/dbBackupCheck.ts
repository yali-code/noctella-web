import { checkBackupReadiness } from "../services/databaseMigrationFoundation";
const r=checkBackupReadiness(process.env.DATABASE_URL); console.log(JSON.stringify(r,null,2)); if(process.env.DATABASE_BACKUP_CHECK_STRICT==="true" && (!r.sqliteBackupPresent || r.rollbackManifestPrerequisite)) process.exit(1);
