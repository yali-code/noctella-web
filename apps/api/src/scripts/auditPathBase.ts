import { posix, win32 } from "node:path";

/**
 * Sprint 69: resolves the apps/api base directory from an arbitrary cwd string, independent of
 * the host OS actually running the check.
 *
 * The bug this replaces: every audit script previously imported basename/dirname/join from the
 * bare "node:path" module, whose behavior is bound to the host platform (posix on Linux/macOS,
 * win32 on Windows). On a Linux CI runner, a Windows-style cwd (backslash-separated) was never
 * recognized as already being inside apps/api - posix basename/dirname don't treat "\" as a
 * separator, so basename("C:\\...\\apps\\api") returns the whole string, not "api". That falsely
 * failed the "already there" check and fell through to path.join(cwd, "apps", "api"), which
 * appends using "/" onto an unrecognized opaque string - producing a duplicated, mixed-separator
 * suffix like "C:\\...\\apps\\api/apps/api".
 *
 * Fixed by explicitly choosing path.win32 or path.posix based on the input string's own
 * separator style (never the ambient host platform via the bare "node:path" import), and using
 * that same chosen style consistently for both the "already there" check and the join - so the
 * two separator styles are never mixed in one result.
 */
export function resolveAuditBase(cwd: string): string {
  const p = cwd.includes("\\") ? win32 : posix;
  return p.basename(cwd) === "api" && p.basename(p.dirname(cwd)) === "apps" ? cwd : p.join(cwd, "apps", "api");
}
