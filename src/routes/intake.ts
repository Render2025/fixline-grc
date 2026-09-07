import type { Env, HoursPerWeek, IntakeFields, UsageContext } from '../types';
import { insertCase, nowIso, recordMetric } from '../lib/db';
import { badRequest, json } from '../lib/http';
import { checkAndRecordRateLimit } from '../lib/rate-limit';
import { putObject, tempResumeKey } from '../lib/r2';
import { assertHumanMode, assertSafeText, enqueueIdentifierOnly } from '../lib/safety';
import { mintAccessToken } from '../lib/tokens';
import { ExtractError, extractResumeText } from '../pipeline/extract';

const HOURS: HoursPerWeek[] = ['lt5', '5-10', '10-20', '20plus'];
const USAGE: UsageContext[] = ['self', 'advisor'];
const MAX_BYTES = 8 * 1024 * 1024;
const V2_FIELDS = ['country','locality','timezone','goal','work_hours','study_hours','income_urgency','income_floor','mobility','transportation','work_authorization','education_status','constraints','usage_context','delivery_preferences','language','accessibility','guided_summary'] as const;
type State = 'KNOWN'|'UNKNOWN'|'WITHHELD'|'OMITTED';

export async function handleIntake(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return badRequest('Method not allowed', 405);
  assertHumanMode(env);
  const ct = request.headers.get('content-type') || '';
  if (ct.includes('application/json')) return handleV2(request, env);
  return handleLegacy(request, env);
}

async function activePolicy(env: Env, supplied: string) {
  if (!supplied) return null;
  return env.DB.prepare(`SELECT id,version FROM v2_policy_version WHERE policy_name='intake_consent' AND is_active=1 AND retired_at IS NULL AND effective_at<=? AND version=?`)
    .bind(nowIso(), supplied).first<{id:string;version:string}>();
}

async function handleV2(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => null) as Record<string, any>|null;
  if (!body || body.college !== 'Green River College') return badRequest('Invalid pilot intake.');
  if (body.consent !== true) return badRequest('Affirmative consent is required.');
  const policy = await activePolicy(env, String(body.policy_version || ''));
  if (!policy) return badRequest('Consent policy version is stale, inactive, invalid, or mismatched.');
  const noResume = body.intake_mode === 'no_resume';
  const guided = typeof body.guided_summary === 'string' ? body.guided_summary.trim() : '';
  if (noResume && guided.length < 20) return badRequest('A guided summary is required without a résumé.');
  if (!noResume) return badRequest('V2 résumé upload must use multipart intake.');
  for (const field of V2_FIELDS) {
    const raw = body[field];
    const value = raw && typeof raw === 'object' && 'state' in raw ? raw.value : raw;
    if (typeof value === 'string') assertSafeText(value);
  }
  const caseId = crypto.randomUUID();
  const {token,hash} = await mintAccessToken();
  const ts = nowIso();
  const usage = String(body.usage_context?.value ?? body.usage_context ?? 'self');
  const goal = String(body.goal?.value ?? body.goal ?? guided).trim();
  if (!goal) return badRequest('Goal is required.');
  // Compatibility row contains only non-contradictory canonical values; no fabricated lt5 fallback.
  await env.DB.prepare(`INSERT INTO cases(id,college,current_goal,work_location,hours_per_week,constraints,usage_context,status,access_token_hash,attempt_count,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,0,?,?)`).bind(caseId,body.college,goal,String(body.locality?.value??body.locality??''),String(body.work_hours?.value??body.work_hours??''),null,USAGE.includes(usage as UsageContext)?usage:'self',noResume?'HUMAN_REVIEW_REQUIRED':'QUEUED',hash,ts,ts).run();
  await env.DB.prepare(`INSERT INTO v2_case(id,intake_mode,policy_version_id,acknowledged_at,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
    .bind(caseId,noResume?'V2_NO_RESUME':'V2_RESUME',policy.id,ts,ts,ts).run();
  const values: unknown[] = V2_FIELDS.map((f) => {
    const raw=body[f]; return raw && typeof raw==='object' && 'state' in raw ? raw.value ?? null : raw ?? null;
  });
  await env.DB.prepare(`INSERT INTO v2_intake(case_id,${V2_FIELDS.join(',')},created_at) VALUES(${Array(V2_FIELDS.length+2).fill('?').join(',')})`).bind(caseId,...values,ts).run();
  for (const field of V2_FIELDS) {
    const raw=body[field];
    const explicit=raw && typeof raw==='object' && 'state' in raw;
    const state:State=explicit?raw.state:(raw===undefined?'OMITTED':'KNOWN');
    if (!['KNOWN','UNKNOWN','WITHHELD','OMITTED'].includes(state)) return badRequest(`Invalid answer state for ${field}`);
    const value=explicit?raw.value:raw;
    await env.DB.prepare(`INSERT INTO v2_user_fact(case_id,field_name,value_json,answer_state,provenance,created_at) VALUES(?,?,?,?,?,?)`)
      .bind(caseId,field,value===undefined?null:JSON.stringify(value),state,'DIRECT_USER',ts).run();
  }
  await env.DB.prepare(`INSERT INTO v2_case_event(case_id,event_type,metadata_json,created_at) VALUES(?,?,?,?)`).bind(caseId,noResume?'NO_RESUME_HUMAN_REVIEW':'INTAKE_ACCEPTED','{}',ts).run();
  await recordMetric(env,'intake_accepted',caseId,usage,{mode:'no_resume'});
  return response(request,caseId,token);
}

async function handleLegacy(request: Request, env: Env): Promise<Response> {
  let form: FormData; try { form=await request.formData(); } catch { return badRequest('Expected multipart form data'); }
  const isV2=form.get('intake_version')==='v2';
  const policy=isV2?await activePolicy(env,String(form.get('policy_version')||'')):null;
  if(isV2 && (form.get('consent')!=='true'||!policy)) return badRequest('Affirmative consent to the active policy is required.');
  const college=String(form.get('college')||'').trim(), current_goal=String(form.get('current_goal')||'').trim();
  const work_location=String(form.get('work_location')||'').trim(), hours_per_week=String(form.get('hours_per_week')||'').trim() as HoursPerWeek;
  const constraints=String(form.get('constraints')||'').trim(), usage_context=String(form.get('usage_context')||'').trim() as UsageContext;
  [current_goal,work_location,constraints].forEach((v)=>assertSafeText(v));
  if(college!=='Green River College'||current_goal.length<5||!work_location||!HOURS.includes(hours_per_week)||!USAGE.includes(usage_context)) return badRequest('Invalid legacy intake fields.');
  const entry=form.get('resume'); if(entry==null||typeof entry==='string') return badRequest('Résumé file is required.');
  const file=entry as unknown as {name:string;type:string;size:number;arrayBuffer():Promise<ArrayBuffer>};
  if(file.size<=0||file.size>MAX_BYTES) return badRequest('Résumé file must be between 1 byte and 8 MB.');
  const bytes=await file.arrayBuffer(), filename=file.name||'resume.bin', contentType=file.type||'application/octet-stream';
  let resumeText:string; try { resumeText=await extractResumeText(bytes,filename,contentType); } catch(e) { return json({message:e instanceof ExtractError?e.message:'Could not read résumé.'},400); }
  if(resumeText.length<40) return json({message:'That résumé appears too short to analyze.'},400);
  const caseId=crypto.randomUUID(), rate=await checkAndRecordRateLimit(env,resumeText,college,caseId); if(!rate.ok)return json({message:rate.message},429);
  const {token,hash}=await mintAccessToken(), key=tempResumeKey(caseId,filename), storedAt=nowIso(), deleteBy=new Date(Date.parse(storedAt)+23*60*60*1000).toISOString();
  await putObject(env,key,bytes,contentType);
  const intake:IntakeFields={college,current_goal,work_location,hours_per_week,constraints,usage_context};
  await insertCase(env,{id:caseId,intake,accessTokenHash:hash,resumeR2Key:key,resumeFilename:filename,resumeContentType:contentType,rateLimitFingerprint:rate.fingerprint});
  await env.DB.prepare(`INSERT INTO v2_case(id,intake_mode,policy_version_id,acknowledged_at,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
    .bind(caseId,isV2?'V2_RESUME':'LEGACY_RESUME',policy?.id??null,isV2?storedAt:null,storedAt,storedAt).run();
  const mapped:Record<string,string>={goal:current_goal,locality:work_location,work_hours:hours_per_week,constraints,usage_context};
  for(const [field,value] of Object.entries(mapped)) await env.DB.prepare(`INSERT INTO v2_user_fact(case_id,field_name,value_json,answer_state,provenance,created_at) VALUES(?,?,?,?,?,?)`)
    .bind(caseId,field,JSON.stringify(value),'KNOWN',isV2?'DIRECT_USER':'LEGACY_MAPPING',storedAt).run();
  const artifactId=crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO v2_artifact(id,case_id,artifact_type,object_key,content_type,byte_length,stored_at,delete_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)`).bind(artifactId,caseId,'RAW_RESUME',key,contentType,file.size,storedAt,deleteBy,storedAt).run();
  await env.DB.prepare(`INSERT INTO v2_deletion_index(artifact_id,status,updated_at) VALUES(?,'PENDING',?)`).bind(artifactId,storedAt).run();
  await enqueueIdentifierOnly(env,{caseId,attemptNumber:1,reason:'initial'});
  await recordMetric(env,'intake_accepted',caseId,usage_context,{hours_per_week});
  return response(request,caseId,token);
}
function response(request:Request,caseId:string,token:string){const base=new URL(request.url).origin;return json({redirect_url:`${base}/status/${caseId}?t=${token}`});}
