// 4C (#424) RC2 acceptance evidence: READ-ONLY (readonly SQLite handle, lstat only). Run from apps/api on the RC2 shell.
//   node ../../scripts/photo-staging-acceptance/4c-evidence.cjs snapshot <photoId> > before.json   (and again > after.json)
//   node ../../scripts/photo-staging-acceptance/4c-evidence.cjs compare before.json after.json
const fs = require("fs"), p = require("path");
const [mode, a, b] = process.argv.slice(2);
if (mode === "snapshot") {
  const D = require(require.resolve("better-sqlite3", { paths: [process.cwd()] })); // the app's module (run from apps/api)
  const db = new D(process.env.DATABASE_URL, { readonly: true, fileMustExist: true }), dir = process.env.PRODUCT_PHOTO_DIR;
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
