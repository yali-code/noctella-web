import { checkSqliteIntegrity } from "../services/databaseMigrationFoundation";
const r=checkSqliteIntegrity(process.env.DATABASE_URL); console.log(JSON.stringify(r,null,2)); if(r.status==="FAIL") process.exit(1);
