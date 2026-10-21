// 4C (#424) RC2 acceptance evidence: READ-ONLY (readonly SQLite handle, lstat only). Run from apps/api on the RC2 shell.
//   node ../../scripts/photo-staging-acceptance/4c-evidence.cjs snapshot <photoId> > before.json   (and again > after.json)
//   node ../../scripts/photo-staging-acceptance/4c-evidence.cjs compare before.json after.json
//   node ../../scripts/photo-staging-acceptance/4c-evidence.cjs due <photoId>   (exit 0 only if the photo-only route
//     POST /api/background-jobs/product-photo-outbox/run would find no product-photo event due except this photo's
//     promote/delete and no stale non-photo lock would be released; other domains are listed for information)
//   node ../../scripts/photo-staging-acceptance/4c-evidence.cjs results <photoId> route-response.json
//   node ../../scripts/photo-staging-acceptance/4c-evidence.cjs recheck before.json now.json   (before reusing a snapshot
//     across a deploy: files, evidence and authority rows unchanged)
//   node ../../scripts/photo-staging-acceptance/4c-evidence.cjs due-event <photoId> <eventId>   (exact-event route
//     POST /api/background-jobs/product-photo-outbox/dispatch-event: exit 0 only if that event is this photo's own delete
//     event and claimable now; the route claims nothing else, so other due rows are listed for information only)
const fs = require("fs"), p = require("path");
const [mode, a, b] = process.argv.slice(2);
const openDb = () => new (require(require.resolve("better-sqlite3", { paths: [process.cwd()] })))(process.env.DATABASE_URL, { readonly: true, fileMustExist: true }); // the app's module (run from apps/api)
if (mode === "due") {
  const db = openDb(), now = new Date().toISOString();
  const jobs = db.prepare("SELECT type, status, COUNT(*) AS n FROM background_jobs WHERE (status IN ('pending', 'retry_pending') AND run_after <= ?) OR status = 'processing' GROUP BY type, status ORDER BY type, status").all(now);
  const outbox = db.prepare("SELECT event_type, status, aggregate_id, COUNT(*) AS n FROM outbox_events WHERE (status IN ('Pending', 'RetryPending') AND available_at <= ?) OR status = 'Processing' GROUP BY event_type, status, aggregate_id ORDER BY event_type, aggregate_id").all(now);
  const social = db.prepare("SELECT COUNT(*) AS n FROM social_publish_schedules s LEFT JOIN social_publish_schedule_executions e ON e.schedule_id = s.id WHERE s.requested_publication_at <= ? AND e.background_job_id IS NULL").get(now).n;
  const cleanupEnabled = process.env.AI_INTAKE_CLEANUP_EXECUTION_ENABLED === "true";
  const photoDomain = outbox.filter((r) => r.event_type.startsWith("product_photo."));
  const unexpectedPhoto = photoDomain.filter((r) => !(r.aggregate_id === a && ["product_photo.promote_requested", "product_photo.delete_requested"].includes(r.event_type)));
  console.log(JSON.stringify({ now, photoDomain, informationOnlyOtherDomains: { jobs, outbox: outbox.filter((r) => !photoDomain.includes(r)), dueSocialSchedules: social, cleanupEnabled } }, null, 1));
  // The route's stale-lock release (as /run's) is not type-scoped: it would requeue any domain's Processing row > 5 min.
  const staleCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const staleOther = db.prepare("SELECT event_type, COUNT(*) AS n FROM outbox_events WHERE status = 'Processing' AND locked_at < ? AND event_type NOT LIKE 'product_photo.%' GROUP BY event_type").all(staleCutoff);
  const clear = unexpectedPhoto.length === 0 && staleOther.length === 0;
  console.log(clear ? "PASS no other product-photo event due and no stale lock to release" : `STOP ${unexpectedPhoto.length ? "another product-photo event is due" : "a stale non-photo lock would be released"}`);
  process.exitCode = clear ? 0 : 1;
} else if (mode === "recheck") {
  // Reusing a pre-DELETE snapshot across a deploy: the canonical files (name, inode, size, mtime), this photo's
  // operation/intent/copy evidence and all authority rows must be exactly unchanged; only the photo row and outbox differ.
  const before = JSON.parse(fs.readFileSync(a, "utf8")), now = JSON.parse(fs.readFileSync(b, "utf8"));
  const checks = {
    "same photo": before.photoId === now.photoId,
    "snapshot holds this photo's evidence and canonical files": !!before.evidence && before.evidence.copies?.length === 2 && before.files.length > 0,
    "canonical files unchanged (name, inode, size, mtime)": JSON.stringify(before.files) === JSON.stringify(now.files),
    "operation/intent/copy evidence unchanged": JSON.stringify(before.evidence) === JSON.stringify(now.evidence),
    "all authority rows unchanged": JSON.stringify(before.authority) === JSON.stringify(now.authority),
  };
  for (const [k, v] of Object.entries(checks)) console.log(`${v ? "PASS" : "FAIL"} ${k}`);
  process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
} else if (mode === "due-event") {
  const db = openDb(), now = new Date().toISOString();
  const e = db.prepare("SELECT id, event_type, aggregate_id, payload, status, available_at, locked_by FROM outbox_events WHERE id = ?").get(b);
  let payloadPhoto = null; try { payloadPhoto = JSON.parse(e?.payload ?? "{}").photoId ?? null; } catch { /* unreadable payload fails below */ }
  const checks = {
    "event exists": !!e,
    "is a product-photo delete event": e?.event_type === "product_photo.delete_requested",
    "aggregate and payload name this photo": e?.aggregate_id === a && payloadPhoto === a,
    "claimable now (Pending/RetryPending, due, unlocked)": ["Pending", "RetryPending"].includes(e?.status) && e?.available_at <= now && e?.locked_by == null,
  };
  const others = db.prepare("SELECT event_type, status, COUNT(*) AS n FROM outbox_events WHERE id <> ? AND ((status IN ('Pending', 'RetryPending') AND available_at <= ?) OR status = 'Processing') GROUP BY event_type, status ORDER BY event_type").all(b, now);
  console.log(JSON.stringify({ now, event: e && { ...e, payload: undefined }, informationOnlyOtherDueRows: others }, null, 1));
  for (const [k, v] of Object.entries(checks)) console.log(`${v ? "PASS" : "FAIL"} ${k}`);
  process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
} else if (mode === "results") {
  // Checks the photo-only route's JSON response: every dispatched event belongs to this photo and is a promote/delete.
  const db = openDb(), response = JSON.parse(fs.readFileSync(b, "utf8"));
  const ids = (response.results ?? []).map((r) => r.eventId);
  const rows = ids.map((id) => db.prepare("SELECT id, event_type, aggregate_id, status FROM outbox_events WHERE id = ?").get(id));
  const ok = ids.length >= 1 && rows.every((r) => r && r.aggregate_id === a && ["product_photo.promote_requested", "product_photo.delete_requested"].includes(r.event_type))
    && rows.some((r) => r.event_type === "product_photo.delete_requested" && r.status === "Succeeded");
  console.log(JSON.stringify(rows, null, 1));
  console.log(ok ? "PASS only this photo's events were dispatched; its delete event Succeeded" : "FAIL unexpected dispatched events or delete not Succeeded");
  process.exitCode = ok ? 0 : 1;
} else if (mode === "snapshot") {
  const db = openDb(), dir = process.env.PRODUCT_PHOTO_DIR;
  const op = db.prepare("SELECT id, state, committed_photo_id, main_key, thumb_key, generation, seal_id FROM photo_operations WHERE target_photo_id = ?").get(a);
  const evidence = op && {
    op,
    intent: db.prepare("SELECT state, main_key, thumb_key, executor_epoch FROM photo_publication_intents WHERE operation_id = ?").get(op.id),
    copies: db.prepare("SELECT artifact, copy_dev, copy_ino, copy_birth_ns, sha256, bytes FROM photo_publication_copies WHERE operation_id = ? ORDER BY artifact").all(op.id),
  };
  const authority = db.prepare("SELECT o.id, o.state, o.generation, i.state AS intent, i.executor_epoch, (SELECT COUNT(*) FROM photo_publication_copies c WHERE c.operation_id = o.id) AS copies FROM photo_operations o LEFT JOIN photo_publication_intents i ON i.operation_id = o.id ORDER BY o.id").all();
  const outbox = db.prepare("SELECT status, attempt_count, last_error_code FROM outbox_events WHERE aggregate_id = ? AND event_type = 'product_photo.delete_requested'").all(a);
  const photoRow = db.prepare("SELECT COUNT(*) AS n FROM product_photos WHERE id = ?").get(a).n;
  const files = fs.readdirSync(dir).sort().map((n) => { const s = fs.lstatSync(p.join(dir, n), { bigint: true }); return `${n} ${s.ino} ${s.size} ${s.mtimeNs}`; });
  console.log(JSON.stringify({ photoId: a, evidence, authority, outbox, photoRow, files }, null, 1));
} else if (mode === "compare") {
  const before = JSON.parse(fs.readFileSync(a, "utf8")), after = JSON.parse(fs.readFileSync(b, "utf8"));
  const ev = before.evidence, keys = ev ? [ev.op.main_key, ev.op.thumb_key] : [];
  const name = (line) => line.split(" ")[0];
  const removed = before.files.filter((f) => !after.files.includes(f)), added = after.files.filter((f) => !before.files.includes(f));
  const checks = {
    "before: committed op, committed intent, 2 copies": !!ev && ev.op.state === "committed" && ev.intent?.state === "committed" && ev.copies.length === 2,
    "before: confined pfs1 copy identity": !!ev && ev.copies.every((c) => /^pfs1:[0-9a-f]{32}:[1-9][0-9]*$/.test(c.copy_dev)),
    "before: photo row present, no delete event": before.photoRow === 1 && before.outbox.length === 0,
    "after: photo row gone": after.photoRow === 0,
    "1 event Succeeded, 1 attempt, no error": after.outbox.length === 1 && after.outbox[0].status === "Succeeded" && Number(after.outbox[0].attempt_count) === 1 && !after.outbox[0].last_error_code,
    "2 exactly this photo's two canonical files removed": removed.length === 2 && removed.map(name).sort().join() === [...keys].sort().join(),
    "3 every other file unchanged, none added": added.length === 0 && before.files.length - after.files.length === 2,
    "4 this operation/intent/copy evidence unchanged": JSON.stringify(before.evidence) === JSON.stringify(after.evidence),
    "4 all other authority rows unchanged": JSON.stringify(before.authority) === JSON.stringify(after.authority),
  };
  for (const [k, v] of Object.entries(checks)) console.log(`${v ? "PASS" : "FAIL"} ${k}`);
  process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
} else { console.error("usage: snapshot <photoId> | compare <before> <after>"); process.exitCode = 2; }
