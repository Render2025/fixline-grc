import type { Env } from '../types';
import { nowIso } from './db';
import { assertHumanMode } from './safety';

/** Five-minute reconciliation. Deadlines are absolute; case/review state is irrelevant. */
export async function runRetentionPurge(env: Env, now = new Date()): Promise<{scanned:number;deleted:number}> {
  assertHumanMode(env);
  const nowValue=now.toISOString();
  const rows=await env.DB.prepare(`SELECT a.id,a.case_id,a.object_key FROM v2_artifact a JOIN v2_deletion_index d ON d.artifact_id=a.id
    WHERE a.deleted_at IS NULL AND d.status IN ('PENDING','FAILED') AND (a.delete_by IS NULL OR julianday(a.delete_by) IS NULL OR a.delete_by<=?)`)
    .bind(nowValue).all<{id:string;case_id:string;object_key:string|null}>();
  let deleted=0;
  for(const row of rows.results??[]){
    if(!row.object_key){await fail(env,row.id,'missing object key',nowValue);continue;}
    try{
      await env.RESUME_BUCKET.delete(row.object_key); // R2 delete is idempotent.
      const deletedAt=nowIso();
      await env.DB.batch([
        env.DB.prepare(`INSERT OR IGNORE INTO v2_deletion_record(artifact_id,case_id,object_key,deleted_at,method) VALUES(?,?,?,?,?)`).bind(row.id,row.case_id,row.object_key,deletedAt,'cron'),
        env.DB.prepare(`UPDATE v2_artifact SET deleted_at=? WHERE id=?`).bind(deletedAt,row.id),
        env.DB.prepare(`UPDATE v2_deletion_index SET status='DELETED',attempts=attempts+1,last_error=NULL,updated_at=? WHERE artifact_id=?`).bind(deletedAt,row.id),
        env.DB.prepare(`UPDATE cases SET resume_r2_key=NULL,resume_deleted_at=?,updated_at=? WHERE id=? AND resume_r2_key=?`).bind(deletedAt,deletedAt,row.case_id,row.object_key),
      ]); deleted++;
    }catch(e){await fail(env,row.id,e instanceof Error?e.message:'delete failed',nowValue);}
  }
  return {scanned:(rows.results??[]).length,deleted};
}
async function fail(env:Env,id:string,error:string,ts:string){await env.DB.prepare(`UPDATE v2_deletion_index SET status='FAILED',attempts=attempts+1,last_error=?,updated_at=? WHERE artifact_id=?`).bind(error.slice(0,500),ts,id).run();}
