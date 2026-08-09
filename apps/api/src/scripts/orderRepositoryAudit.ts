import fs from "node:fs"; import path from "node:path";
import ts from "typescript";
export interface OrderRepositoryAuditResult{status:"PASS"|"FAIL"; violations:string[]}
const forbidden=[/from "\.\.\/db\/schema/,/db\.select\(/,/db\.insert\(/,/db\.update\(/,/sql`/,/applyStockMovementCompatibility/,/Repository\.transaction/,/fetch\(/];
type ExecutionOwner=ts.SourceFile|ts.FunctionDeclaration|ts.FunctionExpression|ts.ArrowFunction|ts.MethodDeclaration;
function isExecutionOwner(node:ts.Node):node is Exclude<ExecutionOwner,ts.SourceFile>{ return ts.isFunctionDeclaration(node)||ts.isFunctionExpression(node)||ts.isArrowFunction(node)||ts.isMethodDeclaration(node); }
function isNamedCall(node:ts.CallExpression,name:string){ return ts.isIdentifier(node.expression)&&node.expression.text===name; }
function isUowRun(node:ts.CallExpression){ if(!ts.isPropertyAccessExpression(node.expression)||node.expression.name.text!=="run") return false; const receiver=node.expression.expression; return ts.isIdentifier(receiver)&&receiver.text==="uow"||ts.isCallExpression(receiver)&&isNamedCall(receiver,"uow"); }
function isPortSync(node:ts.CallExpression){ return ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==="enqueue"&&ts.isIdentifier(node.expression.expression)&&node.expression.expression.text==="sync"; }
function isInsideSyncAdapter(node:ts.Node){ for(let parent=node.parent;parent;parent=parent.parent) if(ts.isVariableDeclaration(parent)&&ts.isIdentifier(parent.name)&&parent.name.text==="sync"&&parent.initializer) return true; return false; }
function auditStockSyncOrdering(source:string){
 const file=ts.createSourceFile("order-audit.ts",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const transactions=new Map<ExecutionOwner,number[]>(), syncs=new Map<ExecutionOwner,number[]>(); let lowLevelBypass=false;
 const add=(map:Map<ExecutionOwner,number[]>,owner:ExecutionOwner,position:number)=>map.set(owner,[...(map.get(owner)??[]),position]);
 const visit=(node:ts.Node,owner:ExecutionOwner)=>{ const nextOwner=isExecutionOwner(node)?node:owner; if(ts.isCallExpression(node)){ if(isUowRun(node)) add(transactions,nextOwner,node.getStart(file)); if(isPortSync(node)) add(syncs,nextOwner,node.getStart(file)); if(isNamedCall(node,"enqueueProductStockSync")&&!isInsideSyncAdapter(node)) lowLevelBypass=true; } ts.forEachChild(node,child=>visit(child,nextOwner)); };
 visit(file,file);
 const invalidPortOrder=[...syncs].some(([owner,positions])=>{ const uowPositions=transactions.get(owner)??[]; const lastTransaction=Math.max(...uowPositions,-1); return positions.some(position=>lastTransaction<0||position<lastTransaction); });
 const violations:string[]=[]; if(invalidPortOrder) violations.push("sync.enqueue must execute after the last uow.run in the same execution scope"); if(lowLevelBypass) violations.push("enqueueProductStockSync is only allowed inside the sync adapter initializer"); return violations;
}
export function auditOrderRepositorySource(source:string){ const violations=forbidden.filter(r=>r.test(source)).map(r=>String(r)); violations.push(...auditStockSyncOrdering(source)); return {status:violations.length?"FAIL":"PASS",violations} as OrderRepositoryAuditResult; }
export function runOrderRepositoryAudit(root=path.resolve(__dirname,"..")){ const files=["services/orders.ts","use-cases/order/useCases.ts"].map(f=>path.join(root,f)); const violations=files.flatMap(f=>auditOrderRepositorySource(fs.readFileSync(f,"utf8")).violations.map(v=>`${f}:${v}`)); return {status:violations.length?"FAIL":"PASS",violations} as OrderRepositoryAuditResult; }
if(require.main===module){ const r=runOrderRepositoryAudit(); console.log(JSON.stringify(r,null,2)); if(r.status!=="PASS") process.exit(1); }
