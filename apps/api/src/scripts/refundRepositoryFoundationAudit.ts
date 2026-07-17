import fs from "node:fs";
import path from "node:path";
const root=path.resolve(__dirname,"..");
const read=(p:string)=>fs.readFileSync(path.join(root,p),"utf8");
const files=["repositories/refund/types.ts","repositories/refund/sqlite.ts","repositories/refund/postgres.ts","repositories/refund/factory.ts","services/unitOfWork.ts"];
const text=files.map(read).join("\n");
const fail:string[]=[];
if(/transaction\s*\(/.test(read("repositories/refund/sqlite.ts")+read("repositories/refund/postgres.ts")+read("repositories/refund/factory.ts"))) fail.push("Refund repository opens transaction");
if(/createDatabaseRuntime|better-sqlite3|postgres\(/.test(text)) fail.push("Refund repository creates DB connection");
if(/\$infer|drizzle-orm/.test(read("repositories/refund/types.ts"))) fail.push("Refund contracts expose schema or Drizzle types");
if(/update|delete/.test(read("repositories/refund/types.ts").match(/interface RefundEventRepository[\s\S]*?}/)?.[0]??"")) fail.push("Refund event repository exposes update/delete");
if(!/refund: RefundRepositories/.test(read("services/unitOfWork.ts"))) fail.push("UnitOfWork does not type Refund repositories");
if(!/createRefundRepositoriesForDb\(tx as unknown as DbClient, "sqlite"\)/.test(read("services/unitOfWork.ts"))) fail.push("SQLite UnitOfWork missing Refund repositories");
if(!/createRefundRepositoriesForDb\(tx as DbClient, "postgres"\)/.test(read("services/unitOfWork.ts"))) fail.push("PostgreSQL UnitOfWork missing Refund repositories");
if(/refund.*use-case|RefundApplication|provider/i.test(text)) fail.push("Out-of-scope Refund application/service/provider migration detected");
if(fail.length){ console.error(fail.join("\n")); process.exit(1); }
console.log("refund repository foundation audit passed");
