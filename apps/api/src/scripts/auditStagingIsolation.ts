import { auditStagingIsolation, parseIsolationAuditInput } from "../use-cases/isolation-audit/stagingIsolationAudit";

/**
 * ADS-009D operator CLI: `npm run ops:isolation-audit -w apps/api < snapshot.json` (or a pipe).
 * Reads the operator-assembled snapshot from STDIN only - never from argv (shell history) or a
 * repository file - and prints only check ids, PASS/FAIL/UNKNOWN and fixed reason codes.
 * No network, database, environment or filesystem access. Exit: 0 PASS, 2 UNKNOWN, 1 FAIL/error.
 */
export async function runIsolationAuditCli(
  args: readonly string[],
  readInput: () => Promise<string>,
  out: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
  err: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
): Promise<number> {
  if (args.length > 0) { err("ISOLATION_AUDIT_ERROR: arguments are not accepted; pipe the snapshot JSON on stdin"); return 1; }
  let raw: string;
  try { raw = await readInput(); } catch { err("ISOLATION_AUDIT_ERROR: INPUT_UNREADABLE"); return 1; }
  const parsed = parseIsolationAuditInput(raw);
  raw = "";
  if (!parsed.ok) { err(`ISOLATION_AUDIT_ERROR: ${parsed.error}`); return 1; }
  try {
    const result = auditStagingIsolation(parsed.input);
    out(JSON.stringify(result, null, 2));
    return result.overall === "PASS" ? 0 : result.overall === "FAIL" ? 1 : 2;
  } catch {
    err("ISOLATION_AUDIT_ERROR: AUDIT_FAILED");
    return 1;
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error("no piped input");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length;
    if (size > 64_000) throw new Error("too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

if (require.main === module) {
  void runIsolationAuditCli(process.argv.slice(2), readStdin).then((code) => { process.exitCode = code; }, () => { process.stderr.write("ISOLATION_AUDIT_ERROR: AUDIT_FAILED\n"); process.exitCode = 1; });
}
