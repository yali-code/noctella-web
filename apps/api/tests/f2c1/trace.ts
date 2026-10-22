/**
 * #472 F2 Contract 1 OFFLINE PROOF ONLY. Trace types and POST-HOC validation.
 *
 * Happens-before rules used by the test (never IPC arrival order across actors):
 * 1. An actor emits AUTHORITY / COMMITTED only after the transaction's commit returned (commit -> emit).
 * 2. The parent sends the next barrier command to actor B only after receiving A's reply, so
 *    A's commit -> A's reply -> parent receipt -> B's command -> B's transaction start.
 * 3. Within one actor, events share one IPC channel and a per-actor sequence, so the parent observes them
 *    in that actor's program order. Cross-actor conclusions use only rule 2 chains.
 * 4. Truly concurrent steps assert only order-independent invariants (one winner, loser never links).
 * Lost acknowledgement: the actor commits but replies SIMULATED_LOST_ACK without an AUTHORITY event, so the
 * parent learns state only from its own database read after a later barrier (or after observed exit).
 */
import path from "node:path";

export type TraceKind = "AUTHORITY" | "LINK_ATTEMPT" | "LINK_RESULT" | "COMMITTED" | "REFUSED" | "LOST_ACK";
export interface TraceEvent { actor: string; seq: number; kind: TraceKind; data: Record<string, any> }

export interface Violation { actor: string; seq: number; reason: string; dst?: string }

/**
 * Every LINK_ATTEMPT must be preceded, in the SAME actor's program order, by an AUTHORITY event whose
 * operation keys include the destination name. Observation never authorized or blocked the call itself.
 */
export function validateLinkAuthorization(events: TraceEvent[]): Violation[] {
  const violations: Violation[] = [];
  const byActor = new Map<string, TraceEvent[]>();
  for (const event of events) byActor.set(event.actor, [...(byActor.get(event.actor) ?? []), event]);
  for (const [actor, list] of byActor) {
    const ordered = [...list].sort((a, b) => a.seq - b.seq);
    const held: Array<{ mainKey: string; thumbKey: string }> = [];
    for (const event of ordered) {
      if (event.kind === "AUTHORITY") held.push({ mainKey: event.data.mainKey, thumbKey: event.data.thumbKey });
      if (event.kind !== "LINK_ATTEMPT") continue;
      const name = path.basename(String(event.data.dst));
      if (!held.some((a) => a.mainKey === name || a.thumbKey === name))
        violations.push({ actor, seq: event.seq, reason: "link attempted without previously acquired authority", dst: name });
    }
  }
  return violations;
}

export const linkAttempts = (events: TraceEvent[], actor: string) => events.filter((e) => e.actor === actor && e.kind === "LINK_ATTEMPT");
