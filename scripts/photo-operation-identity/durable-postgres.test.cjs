'use strict';
// Offline disposable PostgreSQL WAL/transaction identity proof (#424).
// No application tables, migrations, routes, product photos or filesystem writes.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const path=require('node:path');
const {createRequire}=require('node:module');
const api=createRequire(path.resolve(__dirname,'../../apps/api/package.json'));
const {Pool}=api('pg');
const {classify}=require('./identity.cjs');
const intent=Object.freeze({tenantId:'org1',actorId:'admin1',productId:'product1',kind:'W2_PRODUCT_PHOTO_UPLOAD',token:'repeatable-123456',sha256:'a'.repeat(64),altText:'Back view'});
const raw=process.env.POSTGRES_TEST_DATABASE_URL;
function guardedUrl() {
  if (!raw) return null;
  let url;
  try { url=new URL(raw); } catch { throw Error('INVALID_TEST_DB_URL'); }
  const db=decodeURIComponent(url.pathname.slice(1));
  if (!/^postgres(?:ql)?:$/.test(url.protocol)||!/(^|[-_])(test|disposable)([-_]|$)/i.test(db)||/(^|[-_])(prod|production|stage|staging)([-_]|$)/i.test(db)) throw Error('DISPOSABLE_TEST_DB_REQUIRED');
  return raw;
}
test('isolated PostgreSQL claims, generation CAS, atomic binding and lost acknowledgement', {skip:!raw}, async()=>{
  const pool=new Pool({connectionString:guardedUrl(),max:3});
  const schema='w2_disposable_'+crypto.randomBytes(7).toString('hex');
  const q='"'+schema+'"';
  let created=false;
  try {
    await pool.query('CREATE SCHEMA '+q);created=true;
    await pool.query('CREATE TABLE '+q+'.ops(token text PRIMARY KEY,intent jsonb NOT NULL,generation integer NOT NULL,state text NOT NULL,photo_id text,outbox_id text)');
    await pool.query('CREATE TABLE '+q+'.photos(id text PRIMARY KEY,token text UNIQUE NOT NULL)');
    await pool.query('CREATE TABLE '+q+'.outbox(id text PRIMARY KEY,photo_id text UNIQUE NOT NULL)');
    // Two competing claims on independent connections: exactly one INSERT wins.
    const claim=()=>pool.query('INSERT INTO '+q+'.ops(token,intent,generation,state) VALUES($1,$2,1,$3) ON CONFLICT DO NOTHING RETURNING generation',[intent.token,JSON.stringify(intent),'receiving']);
    const pair=await Promise.all([claim(),claim()]);
    assert.deepEqual(pair.map(x=>x.rowCount).sort(),[0,1]);
    const first=await pool.query('SELECT * FROM '+q+'.ops WHERE token=$1',[intent.token]);
    assert.equal(classify(first.rows[0].intent,intent),'SAME_INTENT');
    assert.equal(classify(first.rows[0].intent,{...intent,sha256:'b'.repeat(64)}),'CONFLICT');

    // Uncommitted generation reclaim makes older finisher stale.
    const cas=await pool.query('UPDATE '+q+'.ops SET generation=generation+1 WHERE token=$1 AND generation=1 AND state=$2 RETURNING generation',[intent.token,'receiving']);
    assert.equal(cas.rows[0].generation,2);
    const stale=await pool.query('UPDATE '+q+'.ops SET state=$1 WHERE token=$2 AND generation=1 RETURNING token',['committed',intent.token]);
    assert.equal(stale.rowCount,0);

    // Product row and outbox binding commit together; cannot half-publish.
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO '+q+'.photos(id,token) VALUES($1,$2)',['photo1',intent.token]);
      await client.query('INSERT INTO '+q+'.outbox(id,photo_id) VALUES($1,$2)',['event1','photo1']);
      const done=await client.query('UPDATE '+q+'.ops SET state=$1,photo_id=$2,outbox_id=$3 WHERE token=$4 AND generation=2 AND state=$5 RETURNING token',['committed','photo1','event1',intent.token,'receiving']);
      assert.equal(done.rowCount,1);
      await client.query('COMMIT');
    } catch(e) {await client.query('ROLLBACK');throw e;} finally {client.release();}
    const retry=await pool.query('SELECT state,photo_id,outbox_id,intent FROM '+q+'.ops WHERE token=$1',[intent.token]);
    assert.deepEqual(retry.rows[0].state,'committed');
    assert.deepEqual([retry.rows[0].photo_id,retry.rows[0].outbox_id],['photo1','event1']);
    assert.equal(classify(retry.rows[0].intent,intent),'SAME_INTENT');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+q+'.photos')).rows[0].n,1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+q+'.outbox')).rows[0].n,1);

    // Conflicting second transaction has a duplicate photo; outbox must roll back.
    const client2=await pool.connect();
    try {
      await client2.query('BEGIN');
      await assert.rejects(client2.query('INSERT INTO '+q+'.photos(id,token) VALUES($1,$2)',['photo1','different-token']),{code:'23505'});
      await client2.query('ROLLBACK');
    } finally {client2.release();}
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+q+'.outbox')).rows[0].n,1);
  } finally {
    if(created) await pool.query('DROP SCHEMA '+q+' CASCADE');
    await pool.end();
  }
});
test('PostgreSQL proof rejects non-disposable URLs',()=>{
  if(!raw) return;
  assert.ok(guardedUrl());
});
