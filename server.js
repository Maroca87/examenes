import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile();
const PORT = Number(process.env.PORT || 3000);
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 7);
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(ROOT, 'data', 'backups');
const BACKUP_KEEP = Math.max(7, Number(process.env.BACKUP_KEEP_DAYS || 30));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, idleTimeoutMillis: 30_000 });
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };
const loginFailures = new Map();

function loadEnvFile() {
  try {
    for (const line of fsSync.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
}
const query = (text, values = []) => pool.query(text, values);
const id = () => crypto.randomUUID();
const tokenHash = value => crypto.createHash('sha256').update(value).digest('hex');
const hashPassword = password => {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
};
const checkPassword = (password, stored) => {
  try {
    const [scheme, salt, expected] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), 64);
    const expectedBytes = Buffer.from(expected, 'hex');
    return actual.length === expectedBytes.length && crypto.timingSafeEqual(actual, expectedBytes);
  } catch { return false; }
};
const safeUser = row => ({ id:row.id, username:row.username, name:row.full_name, email:row.email, role:row.role, active:row.active, mustChangePassword:row.must_change_password, createdAt:row.created_at });
const json = (res, status, data, extraHeaders = {}) => {
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', ...extraHeaders });
  res.end(JSON.stringify(data));
};
const fail = (res, status, message) => json(res, status, { error:message });
const cookieValue = (req, key) => (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${key}=`))?.slice(key.length + 1);
const setSessionCookie = (res, token, maxAge) => res.setHeader('Set-Cookie', `examena_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
const clearSessionCookie = res => res.setHeader('Set-Cookie', 'examena_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + (process.env.NODE_ENV === 'production' ? '; Secure' : ''));
const readBody = req => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 25_000_000) { reject(Object.assign(new Error('La solicitud es demasiado grande.'), { status:413 })); req.destroy(); } });
  req.on('end', () => { if (!body) return resolve({}); try { resolve(JSON.parse(body)); } catch { reject(Object.assign(new Error('El cuerpo debe ser JSON válido.'), { status:400 })); } });
  req.on('error', reject);
});
const needText = (value, label, max = 3000) => {
  const out = typeof value === 'string' ? value.trim() : '';
  if (!out || out.length > max) throw Object.assign(new Error(`${label} es obligatorio y debe tener ${max} caracteres o menos.`), { status:400 });
  return out;
};
const roleIn = (...roles) => req => roles.includes(req.user.role);

async function migrate() {
  await query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const migrationsDir = path.join(ROOT, 'db', 'migrations');
  const files = (await fs.readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort();
  for (const name of files) {
    const applied = await query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
    if (applied.rowCount) continue;
    const sql = await fs.readFile(path.join(migrationsDir, name), 'utf8');
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(sql); await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    console.log(`Migración aplicada: ${name}`);
  }
}

async function ensureSuperadmin() {
  const username = String(process.env.SUPERADMIN_USERNAME || '').trim().toLowerCase();
  const password = String(process.env.SUPERADMIN_PASSWORD || '');
  const fullName = String(process.env.SUPERADMIN_NAME || 'Superadministrador').trim();
  if (!username || password.length < 12 || password.length > 128) throw new Error('Configura SUPERADMIN_USERNAME y una SUPERADMIN_PASSWORD de 12 a 128 caracteres en Railway.');
  const existing = await query("SELECT id FROM users WHERE role = 'superadmin' LIMIT 1");
  if (existing.rowCount) return;
  await query('INSERT INTO users(username, full_name, password_hash, role, active, must_change_password) VALUES($1,$2,$3,\'superadmin\',TRUE,FALSE)', [username, fullName, hashPassword(password)]);
  console.log(`Cuenta inicial creada para ${username}.`);
}

async function seedInitialExam() {
  const seedName = 'seed_initial_exam_v1';
  if ((await query('SELECT 1 FROM schema_migrations WHERE name=$1', [seedName])).rowCount) return;
  const seed = JSON.parse(await fs.readFile(path.join(ROOT, 'db', 'seeds', 'initial-exam.json'), 'utf8'));
  const superadmin = (await query("SELECT id FROM users WHERE role='superadmin' ORDER BY created_at,id LIMIT 1")).rows[0];
  if (!superadmin) throw new Error('No se encontró la cuenta superadministradora para cargar el examen inicial.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(7401023)');
    if ((await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [seedName])).rowCount) {
      await client.query('COMMIT');
      return;
    }
    const alreadyExists = (await client.query('SELECT id FROM exams WHERE title=$1 LIMIT 1', [seed.title])).rows[0];
    if (!alreadyExists) {
      const exam = (await client.query(`INSERT INTO exams(title,description,duration_minutes,version,status,created_by)
        VALUES($1,$2,$3,$4,'draft',$5) RETURNING id`, [seed.title, seed.description, seed.durationMinutes, seed.version, superadmin.id])).rows[0];
      for (const [position, question] of seed.questions.entries()) {
        await client.query(`INSERT INTO questions(exam_id,section,type,prompt,options,answer_key,points,position)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [
          exam.id, question.section, question.type, question.prompt,
          question.options == null ? null : JSON.stringify(question.options),
          question.answerKey == null ? null : JSON.stringify(question.answerKey),
          question.points, position
        ]);
      }
    }
    await client.query('INSERT INTO schema_migrations(name) VALUES($1) ON CONFLICT DO NOTHING', [seedName]);
    await client.query('COMMIT');
    console.log(`Examen inicial disponible con ${seed.questions.length} preguntas; puntaje máximo: ${seed.questions.reduce((total, question) => total + question.points, 0)}.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function audit(req, action, targetType = null, targetId = null, detail = {}) {
  await query('INSERT INTO audit_logs(actor_id, actor_role, action, target_type, target_id, detail) VALUES($1,$2,$3,$4,$5,$6)', [req.user?.id || null, req.user?.role || null, action, targetType, targetId == null ? null : String(targetId), JSON.stringify(detail)]);
}

async function getUser(req) {
  const token = cookieValue(req, 'examena_session');
  if (!token) return null;
  const result = await query(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=TRUE`, [tokenHash(decodeURIComponent(token))]);
  return result.rows[0] || null;
}

async function authenticate(req, res, roles = null) {
  req.user = await getUser(req);
  if (!req.user) { fail(res, 401, 'Inicia sesión para continuar.'); return false; }
  if (req.user.must_change_password && !['/api/auth/change-password', '/api/auth/me', '/api/auth/logout'].includes(new URL(req.url, 'http://localhost').pathname)) {
    fail(res, 403, 'Debes cambiar tu contraseña temporal antes de continuar.'); return false;
  }
  if (roles && !roles.includes(req.user.role)) { fail(res, 403, 'No tienes permiso para esta acción.'); return false; }
  return true;
}

async function createBackup() {
  await fs.mkdir(BACKUP_DIR, { recursive:true });
  const tables = ['users','exams','questions','exam_assignments','attempts','attempt_answers','audit_logs','schema_migrations'];
  const backup = { format:'examena-backup-v1', createdAt:new Date().toISOString(), tables:{} };
  for (const table of tables) backup.tables[table] = (await query(table==='users'?'SELECT * FROM users ORDER BY created_at,id':`SELECT * FROM ${table} ORDER BY 1`)).rows;
  const file = `examena-${new Date().toISOString().replace(/[:.]/g,'-')}.json.gz`;
  const gzip = await import('node:zlib');
  const data = await new Promise((resolve,reject) => gzip.gzip(Buffer.from(JSON.stringify(backup)), { level:9 }, (error, result) => error ? reject(error) : resolve(result)));
  await fs.writeFile(path.join(BACKUP_DIR, file), data, { mode:0o600 });
  const all = (await fs.readdir(BACKUP_DIR)).filter(x => /^examena-.*\.json\.gz$/.test(x)).sort().reverse();
  const cutoff = Date.now() - BACKUP_KEEP * 86_400_000;
  for (const name of all) { const stat = await fs.stat(path.join(BACKUP_DIR,name)); if (stat.mtimeMs < cutoff) await fs.rm(path.join(BACKUP_DIR,name), { force:true }); }
  return { file, bytes:data.length, createdAt:backup.createdAt };
}
async function backupScheduler() {
  try {
    await fs.mkdir(BACKUP_DIR, { recursive:true });
    const files=(await fs.readdir(BACKUP_DIR)).filter(x=>/^examena-.*\.json\.gz$/.test(x));
    const latest=files.length?Math.max(...await Promise.all(files.map(async name=>(await fs.stat(path.join(BACKUP_DIR,name))).mtimeMs))):0;
    if (Date.now()-latest > 23*60*60*1000) console.log('Respaldo diario:', (await createBackup()).file);
  } catch(error) { console.error('No se pudo generar el respaldo diario:',error.message); }
  setTimeout(backupScheduler, 60*60*1000).unref();
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const method = req.method;
  if (method === 'GET' && p === '/api/health') return json(res,200,{ok:true,service:'examena'});

  if (method === 'POST' && p === '/api/auth/login') {
    const body=await readBody(req), username=String(body.username||'').trim().toLowerCase(), password=String(body.password||'');
    if(password.length>128)return fail(res,401,'Usuario o contraseña incorrectos.');
    const remote=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim(), rateKey=`${remote}:${username}`, now=Date.now();
    const recent=(loginFailures.get(rateKey)||[]).filter(timestamp=>now-timestamp<15*60_000);
    if(recent.length>=10)return fail(res,429,'Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.');
    const result=await query('SELECT * FROM users WHERE username=$1',[username]);
    const user=result.rows[0];
    if(!user||!user.active||!checkPassword(password,user.password_hash)){recent.push(now);loginFailures.set(rateKey,recent);await query('INSERT INTO audit_logs(actor_role,action,target_type,detail) VALUES(NULL,\'login_failed\',\'user\',$1)',[JSON.stringify({username})]);return fail(res,401,'Usuario o contraseña incorrectos.')}
    loginFailures.delete(rateKey);
    const token=crypto.randomBytes(32).toString('base64url'),expires=new Date(Date.now()+SESSION_DAYS*86_400_000);
    await query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[tokenHash(token),user.id,expires]);
    await query("INSERT INTO audit_logs(actor_id,actor_role,action,target_type,target_id) VALUES($1,$2,'login','user',$1)",[user.id,user.role]);
    setSessionCookie(res,token,SESSION_DAYS*86_400);return json(res,200,{user:safeUser(user)});
  }
  if(method==='POST'&&p==='/api/auth/logout'){const token=cookieValue(req,'examena_session');if(token)await query('DELETE FROM sessions WHERE token_hash=$1',[tokenHash(decodeURIComponent(token))]);clearSessionCookie(res);return json(res,200,{ok:true})}
  if(method==='GET'&&p==='/api/auth/me'){if(!await authenticate(req,res))return;return json(res,200,{user:safeUser(req.user)})}
  if(method==='POST'&&p==='/api/auth/change-password'){
    if(!await authenticate(req,res))return;const body=await readBody(req),password=String(body.password||'');
    if(password.length<12||password.length>128)return fail(res,400,'La contraseña nueva debe tener entre 12 y 128 caracteres.');
    await query('UPDATE users SET password_hash=$1,must_change_password=FALSE,updated_at=now() WHERE id=$2',[hashPassword(password),req.user.id]);await audit(req,'password_changed','user',req.user.id);return json(res,200,{ok:true});
  }

  if(!await authenticate(req,res))return;
  const user=req.user;
  if(method==='GET'&&p==='/api/dashboard'){
    if(user.role==='candidate')return fail(res,403,'No tienes permiso para ver el dashboard administrativo.');
    const [exams,candidates,attempts,stats]=await Promise.all([
      query('SELECT count(*)::int AS count FROM exams WHERE status=\'published\''),
      query("SELECT count(*)::int AS count FROM users WHERE role='candidate' AND active=TRUE"),
      query("SELECT count(*)::int AS count FROM attempts WHERE status='submitted'"),
      query("SELECT count(*)::int AS count, COALESCE(round(avg(final_score::numeric*100/NULLIF(final_max,0))),0)::int AS average FROM attempts WHERE status='released'")
    ]);
    return json(res,200,{exams:exams.rows[0].count,candidates:candidates.rows[0].count,pending:attempts.rows[0].count,released:stats.rows[0].count,average:stats.rows[0].average});
  }

  if(method==='GET'&&p==='/api/users'){
    if(!['superadmin','admin'].includes(user.role))return fail(res,403,'Sin permiso.');
    const filter=user.role==='admin'?"WHERE role='candidate'":'';
    return json(res,200,{users:(await query(`SELECT id,username,full_name,email,role,active,must_change_password,created_at FROM users ${filter} ORDER BY created_at DESC`)).rows});
  }
  if(method==='POST'&&p==='/api/users'){
    if(!['superadmin','admin'].includes(user.role))return fail(res,403,'Sin permiso.');
    const b=await readBody(req),role=String(b.role||'candidate'),username=needText(b.username,'El usuario',80).toLowerCase(),name=needText(b.name,'El nombre',160),password=String(b.password||'');
    if(user.role==='admin'&&role!=='candidate')return fail(res,403,'El administrador solo puede crear cuentas de candidato.');
    if(!['candidate','admin','superadmin'].includes(role))return fail(res,400,'Rol inválido.');
    if(password.length<12||password.length>128)return fail(res,400,'La contraseña inicial debe tener entre 12 y 128 caracteres.');
    if(role==='superadmin'&&user.role!=='superadmin')return fail(res,403,'Solo el superadministrador puede crear otro superadministrador.');
    const result=await query('INSERT INTO users(username,full_name,email,password_hash,role,must_change_password,created_by) VALUES($1,$2,$3,$4,$5,TRUE,$6) RETURNING id,username,full_name,email,role,active,must_change_password,created_at',[username,name,String(b.email||'').trim()||null,hashPassword(password),role,user.id]);
    await audit(req,'user_created','user',result.rows[0].id,{role});return json(res,201,{user:safeUser(result.rows[0])});
  }
  const userMatch=p.match(/^\/api\/users\/([\da-f-]+)$/i);
  if(userMatch&&method==='PATCH'){
    if(!['superadmin','admin'].includes(user.role))return fail(res,403,'Sin permiso.');const target=(await query('SELECT * FROM users WHERE id=$1',[userMatch[1]])).rows[0];if(!target)return fail(res,404,'Usuario no encontrado.');
    if(user.role==='admin'&&target.role!=='candidate')return fail(res,403,'El administrador solo puede modificar cuentas de candidato.');
    const b=await readBody(req);if(typeof b.active==='boolean')await query('UPDATE users SET active=$1,updated_at=now() WHERE id=$2',[b.active,target.id]);if(typeof b.name==='string'&&b.name.trim())await query('UPDATE users SET full_name=$1,updated_at=now() WHERE id=$2',[b.name.trim(),target.id]);
    if(b.role!==undefined){if(user.role!=='superadmin')return fail(res,403,'Solo el superadministrador puede cambiar roles.');if(!['superadmin','admin','candidate'].includes(b.role))return fail(res,400,'Rol inválido.');if(target.role==='superadmin'&&b.role!=='superadmin'&&(await query("SELECT count(*)::int AS count FROM users WHERE role='superadmin' AND active=TRUE")).rows[0].count<=1)return fail(res,400,'Debe quedar al menos un superadministrador.');await query('UPDATE users SET role=$1,updated_at=now() WHERE id=$2',[b.role,target.id]);}
    await audit(req,'user_updated','user',target.id,{active:b.active});return json(res,200,{ok:true});
  }
  if(userMatch&&method==='DELETE'){
    if(user.role!=='superadmin')return fail(res,403,'Solo el superadministrador puede eliminar usuarios.');if(user.id===userMatch[1])return fail(res,400,'No puedes eliminar tu propia cuenta.');
    const target=(await query('SELECT * FROM users WHERE id=$1',[userMatch[1]])).rows[0];if(!target)return fail(res,404,'Usuario no encontrado.');
    if(target.role==='superadmin'&&(await query("SELECT count(*)::int AS count FROM users WHERE role='superadmin' AND active=TRUE")).rows[0].count<=1)return fail(res,400,'Debe quedar al menos un superadministrador activo.');
    const hasHistory=target.role==='candidate'&&(await query('SELECT 1 FROM attempts WHERE candidate_id=$1 LIMIT 1',[target.id])).rowCount>0;
    if(hasHistory)await query("UPDATE users SET username=$1,email=NULL,full_name='Cuenta eliminada',password_hash=$2,active=FALSE,updated_at=now() WHERE id=$3",[`deleted-${target.id}`,hashPassword(crypto.randomBytes(32).toString('hex')),target.id]);else await query('DELETE FROM users WHERE id=$1',[target.id]);
    await audit(req,'user_deleted','user',target.id,{anonymized:hasHistory});return json(res,200,{ok:true,historyPreserved:hasHistory});
  }

  if(method==='GET'&&p==='/api/exams'){
    if(user.role==='candidate'){
      const result=await query(`SELECT e.*, count(q.id)::int AS question_count FROM exam_assignments a JOIN exams e ON e.id=a.exam_id LEFT JOIN questions q ON q.exam_id=e.id WHERE a.candidate_id=$1 AND e.status='published' GROUP BY e.id ORDER BY e.created_at DESC`,[user.id]);return json(res,200,{exams:result.rows});
    }
    const result=await query(`SELECT e.*,count(q.id)::int AS question_count FROM exams e LEFT JOIN questions q ON q.exam_id=e.id GROUP BY e.id ORDER BY e.updated_at DESC`);return json(res,200,{exams:result.rows});
  }
  if(method==='POST'&&p==='/api/exams'){
    if(!['superadmin','admin'].includes(user.role))return fail(res,403,'Sin permiso.');const b=await readBody(req),title=needText(b.title,'El nombre del examen',200),description=String(b.description||'').slice(0,3000),duration=Number(b.durationMinutes||90);
    if(!Number.isInteger(duration)||duration<1||duration>600)return fail(res,400,'La duración debe ser de 1 a 600 minutos.');
    const result=await query('INSERT INTO exams(title,description,duration_minutes,version,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',[title,description,duration,String(b.version||'1.0'),user.id]);await audit(req,'exam_created','exam',result.rows[0].id);return json(res,201,{exam:result.rows[0]});
  }
  const examMatch=p.match(/^\/api\/exams\/([\da-f-]+)$/i);
  if(examMatch&&method==='PATCH'){
    if(!['superadmin','admin'].includes(user.role))return fail(res,403,'Sin permiso.');const b=await readBody(req);if(b.status!==undefined&&!['draft','published','archived'].includes(b.status))return fail(res,400,'Estado de examen inválido.');if(b.status==='published'&&!(await query('SELECT 1 FROM questions WHERE exam_id=$1 LIMIT 1',[examMatch[1]])).rowCount)return fail(res,400,'Agrega al menos una pregunta antes de publicar.');const result=await query(`UPDATE exams SET title=COALESCE($1,title),description=COALESCE($2,description),duration_minutes=COALESCE($3,duration_minutes),version=COALESCE($4,version),status=COALESCE($5,status),updated_at=now() WHERE id=$6 RETURNING *`,[b.title??null,b.description??null,b.durationMinutes??null,b.version??null,b.status??null,examMatch[1]]);if(!result.rowCount)return fail(res,404,'Examen no encontrado.');await audit(req,'exam_updated','exam',examMatch[1]);return json(res,200,{exam:result.rows[0]});
  }
  if(examMatch&&method==='DELETE'){
    if(user.role!=='superadmin')return fail(res,403,'Solo el superadministrador puede eliminar exámenes.');if((await query('SELECT 1 FROM attempts WHERE exam_id=$1 LIMIT 1',[examMatch[1]])).rowCount)return fail(res,409,'El examen tiene entregas y no puede eliminarse; puedes archivarlo.');await query('DELETE FROM exams WHERE id=$1',[examMatch[1]]);await audit(req,'exam_deleted','exam',examMatch[1]);return json(res,200,{ok:true});
  }
  const duplicateMatch=p.match(/^\/api\/exams\/([\da-f-]+)\/duplicate$/i);
  if(duplicateMatch&&method==='POST'){
    if(!['superadmin','admin'].includes(user.role))return fail(res,403,'Sin permiso.');const client=await pool.connect();try{await client.query('BEGIN');const source=(await client.query('SELECT * FROM exams WHERE id=$1',[duplicateMatch[1]])).rows[0];if(!source){await client.query('ROLLBACK');return fail(res,404,'Examen no encontrado.')}const copied=(await client.query("INSERT INTO exams(title,description,duration_minutes,version,status,created_by) VALUES($1,$2,$3,$4,'draft',$5) RETURNING *",[`${source.title} · Nueva versión`,source.description,source.duration_minutes,source.version,user.id])).rows[0];await client.query(`INSERT INTO questions(exam_id,section,type,prompt,options,answer_key,points,position) SELECT $1,section,type,prompt,options,answer_key,points,position FROM questions WHERE exam_id=$2`,[copied.id,source.id]);await client.query('COMMIT');await audit(req,'exam_duplicated','exam',copied.id,{sourceExamId:source.id});return json(res,201,{exam:copied})}catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  }
  const questionMatch=p.match(/^\/api\/exams\/([\da-f-]+)\/questions$/i);
  if(questionMatch&&method==='GET'){
    const exam=questionMatch[1];if(user.role==='candidate'&&!(await query("SELECT 1 FROM exam_assignments a JOIN exams e ON e.id=a.exam_id WHERE a.exam_id=$1 AND a.candidate_id=$2 AND e.status='published'",[exam,user.id])).rowCount)return fail(res,403,'Este examen no está asignado a tu cuenta.');
    const rows=(await query('SELECT id,exam_id,section,type,prompt,options,points,position FROM questions WHERE exam_id=$1 ORDER BY position,id',[exam])).rows;return json(res,200,{questions:rows});
  }
  if(questionMatch&&method==='POST'){
    if(!['superadmin','admin'].includes(user.role))return fail(res,403,'Sin permiso.');const b=await readBody(req),type=String(b.type||''),prompt=needText(b.prompt,'El enunciado',5000),points=['short','development'].includes(type)?2:1;if(!['choice','boolean','short','development'].includes(type))return fail(res,400,'Tipo de pregunta inválido.');
    let key=b.answerKey;if(type==='choice'&&(!Array.isArray(b.options)||b.options.length<2||b.options.length>6||!Number.isInteger(Number(key))))return fail(res,400,'La pregunta de selección requiere opciones y una respuesta correcta.');if(type==='boolean'&&typeof key!=='boolean')return fail(res,400,'Indica la respuesta correcta verdadero/falso.');if(type==='short'||type==='development')key=null;
    const result=await query('INSERT INTO questions(exam_id,section,type,prompt,options,answer_key,points,position) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,exam_id,section,type,prompt,options,points,position',[questionMatch[1],String(b.section||'General').slice(0,120),type,prompt,b.options?JSON.stringify(b.options):null,key==null?null:JSON.stringify(key),points,Number(b.position||0)]);await audit(req,'question_created','exam',questionMatch[1]);return json(res,201,{question:result.rows[0]});
  }
  const oneQuestion=p.match(/^\/api\/questions\/([\da-f-]+)$/i);
  if(oneQuestion&&(method==='PATCH'||method==='DELETE')){
    if(!['superadmin','admin'].includes(user.role))return fail(res,403,'Sin permiso.');const question=(await query('SELECT * FROM questions WHERE id=$1',[oneQuestion[1]])).rows[0];if(!question)return fail(res,404,'Pregunta no encontrada.');if((await query('SELECT 1 FROM attempts WHERE exam_id=$1 LIMIT 1',[question.exam_id])).rowCount)return fail(res,409,'El examen ya tiene entregas. Duplica el examen para editar esta pregunta sin alterar el historial.');
    if(method==='DELETE'){await query('DELETE FROM questions WHERE id=$1',[question.id]);await audit(req,'question_deleted','question',question.id);return json(res,200,{ok:true})}
    const b=await readBody(req),type=String(b.type||question.type);if(!['choice','boolean','short','development'].includes(type))return fail(res,400,'Tipo inválido.');const key=(type==='choice'||type==='boolean')?b.answerKey: null;if(type==='choice'&&(!Array.isArray(b.options)||!Number.isInteger(Number(key))))return fail(res,400,'Opciones y respuesta correcta son obligatorias.');if(type==='boolean'&&typeof key!=='boolean')return fail(res,400,'Respuesta correcta verdadero/falso requerida.');const result=await query('UPDATE questions SET section=$1,type=$2,prompt=$3,options=$4,answer_key=$5,points=$6,position=$7 WHERE id=$8 RETURNING id,exam_id,section,type,prompt,options,points,position',[String(b.section||question.section),type,needText(b.prompt??question.prompt,'El enunciado',5000),b.options?JSON.stringify(b.options):null,key==null?null:JSON.stringify(key),['short','development'].includes(type)?2:1,Number(b.position??question.position),question.id]);await audit(req,'question_updated','question',question.id);return json(res,200,{question:result.rows[0]});
  }
  const assignmentMatch=p.match(/^\/api\/exams\/([\da-f-]+)\/assignments$/i);
  if(assignmentMatch&&method==='POST'){
    if(!['superadmin','admin'].includes(user.role))return fail(res,403,'Sin permiso.');const b=await readBody(req),candidateId=String(b.candidateId||'');if(!(await query("SELECT 1 FROM users WHERE id=$1 AND role='candidate' AND active=TRUE",[candidateId])).rowCount)return fail(res,404,'Candidato activo no encontrado.');await query('INSERT INTO exam_assignments(exam_id,candidate_id,assigned_by) VALUES($1,$2,$3) ON CONFLICT(exam_id,candidate_id) DO NOTHING',[assignmentMatch[1],candidateId,user.id]);await audit(req,'exam_assigned','exam',assignmentMatch[1],{candidateId});return json(res,201,{ok:true});
  }

  if(method==='POST'&&p==='/api/attempts'){
    if(user.role!=='candidate')return fail(res,403,'Solo un candidato puede comenzar una evaluación.');const b=await readBody(req),examId=String(b.examId||'');
    const allowed=await query("SELECT e.* FROM exam_assignments a JOIN exams e ON e.id=a.exam_id WHERE e.id=$1 AND e.status='published' AND a.candidate_id=$2",[examId,user.id]);if(!allowed.rowCount)return fail(res,404,'No tienes este examen asignado.');
    const active=await query("SELECT id FROM attempts WHERE candidate_id=$1 AND exam_id=$2 AND status='in_progress'",[user.id,examId]);if(active.rowCount)return json(res,200,{attemptId:active.rows[0].id});
    const attempt=await query('INSERT INTO attempts(exam_id,candidate_id,final_max,open_max) SELECT $1,$2,COALESCE(sum(points),0),COALESCE(sum(points) FILTER(WHERE type IN (\'short\',\'development\')),0) FROM questions WHERE exam_id=$1 RETURNING *',[examId,user.id]);await audit(req,'attempt_started','attempt',attempt.rows[0].id);return json(res,201,{attemptId:attempt.rows[0].id});
  }
  const attemptMatch=p.match(/^\/api\/attempts\/([\da-f-]+)$/i);
  if(attemptMatch&&method==='GET'){
    const result=await query(`SELECT a.*,e.title AS exam_title,e.duration_minutes,u.full_name AS candidate_name
      FROM attempts a JOIN exams e ON e.id=a.exam_id JOIN users u ON u.id=a.candidate_id WHERE a.id=$1`,[attemptMatch[1]]);const attempt=result.rows[0];if(!attempt)return fail(res,404,'Entrega no encontrada.');const candidateOwn=user.role==='candidate'&&attempt.candidate_id===user.id;if(!candidateOwn&&!['superadmin','admin'].includes(user.role))return fail(res,403,'Sin permiso.');if(user.role==='candidate'&&!candidateOwn)return fail(res,403,'Sin permiso.');
    const answers=(await query(`SELECT q.id AS question_id,q.section,q.type,q.prompt,q.options,q.points,aa.response,aa.points_awarded,aa.reviewer_comment
      FROM questions q LEFT JOIN attempt_answers aa ON aa.question_id=q.id AND aa.attempt_id=$1 WHERE q.exam_id=$2 ORDER BY q.position,q.id`,[attempt.id,attempt.exam_id])).rows;
    if(user.role==='candidate'&&attempt.status!=='released')return json(res,200,{attempt:{id:attempt.id,status:attempt.status,exam_title:attempt.exam_title,started_at:attempt.started_at,duration_minutes:attempt.duration_minutes},answers:answers.map(({points_awarded,reviewer_comment,...answer})=>answer)});
    return json(res,200,{attempt,answers});
  }
  const answersMatch=p.match(/^\/api\/attempts\/([\da-f-]+)\/answers$/i);
  if(answersMatch&&method==='PUT'){
    if(user.role!=='candidate')return fail(res,403,'Solo el candidato puede guardar sus respuestas.');const a=(await query('SELECT * FROM attempts WHERE id=$1 AND candidate_id=$2',[answersMatch[1],user.id])).rows[0];if(!a||a.status!=='in_progress')return fail(res,409,'La evaluación ya fue entregada o no existe.');
    const time=await query('SELECT e.duration_minutes FROM exams e WHERE e.id=$1',[a.exam_id]);if(Date.now()-new Date(a.started_at).getTime()>time.rows[0].duration_minutes*60_000)return fail(res,409,'Se agotó el tiempo disponible.');
    const b=await readBody(req),answers=b.answers;if(!answers||typeof answers!=='object'||Array.isArray(answers))return fail(res,400,'Formato de respuestas inválido.');
    const questions=(await query('SELECT id FROM questions WHERE exam_id=$1',[a.exam_id])).rows;const valid=new Set(questions.map(q=>q.id));const client=await pool.connect();try{await client.query('BEGIN');for(const [questionId,response]of Object.entries(answers)){if(!valid.has(questionId))continue;await client.query('INSERT INTO attempt_answers(attempt_id,question_id,response) VALUES($1,$2,$3) ON CONFLICT(attempt_id,question_id) DO UPDATE SET response=EXCLUDED.response',[a.id,questionId,JSON.stringify(response)])}await client.query('COMMIT')}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}return json(res,200,{ok:true});
  }
  const submitMatch=p.match(/^\/api\/attempts\/([\da-f-]+)\/submit$/i);
  if(submitMatch&&method==='POST'){
    if(user.role!=='candidate')return fail(res,403,'Solo el candidato puede entregar.');const a=(await query('SELECT * FROM attempts WHERE id=$1 AND candidate_id=$2',[submitMatch[1],user.id])).rows[0];if(!a||a.status!=='in_progress')return fail(res,409,'La evaluación no está disponible para entrega.');
    const duration=Number((await query('SELECT duration_minutes FROM exams WHERE id=$1',[a.exam_id])).rows[0].duration_minutes);if(Date.now()-new Date(a.started_at).getTime()>duration*60_000)return fail(res,409,'Se agotó el tiempo disponible.');
    const score=await query(`SELECT COALESCE(sum(CASE WHEN q.type IN ('choice','boolean') AND aa.response=q.answer_key THEN 1 ELSE 0 END),0)::int AS earned,
      COALESCE(sum(q.points) FILTER(WHERE q.type IN ('choice','boolean')),0)::int AS maximum FROM questions q LEFT JOIN attempt_answers aa ON aa.question_id=q.id AND aa.attempt_id=$1 WHERE q.exam_id=$2`,[a.id,a.exam_id]);
    await query("UPDATE attempts SET status='submitted',submitted_at=now(),objective_score=$1,objective_max=$2 WHERE id=$3",[score.rows[0].earned,score.rows[0].maximum,a.id]);await audit(req,'attempt_submitted','attempt',a.id);return json(res,200,{ok:true,status:'submitted'});
  }
  const reviewMatch=p.match(/^\/api\/attempts\/([\da-f-]+)\/review$/i);
  if(reviewMatch&&method==='POST'){
    if(!['superadmin','admin'].includes(user.role))return fail(res,403,'Sin permiso para calificar.');const b=await readBody(req),a=(await query('SELECT * FROM attempts WHERE id=$1',[reviewMatch[1]])).rows[0];if(!a||!['submitted','reviewed'].includes(a.status))return fail(res,409,'La entrega aún no está lista para análisis.');
    const open=(await query("SELECT q.id FROM questions q WHERE q.exam_id=$1 AND q.type IN ('short','development')",[a.exam_id])).rows;const grades=b.grades||{};for(const q of open)if(![0,1,2].includes(Number(grades[q.id])))return fail(res,400,'Califica todas las respuestas abiertas con 0, 1 o 2.');
    const analysis=needText(b.analysis,'El análisis del perfil',5000),recommendation=needText(b.recommendation,'La recomendación',200);if(!['Recomendado','Recomendado con observaciones','No recomendado'].includes(recommendation))return fail(res,400,'Recomendación inválida.');
    const client=await pool.connect();try{await client.query('BEGIN');let openScore=0;for(const q of open){const score=Number(grades[q.id]);openScore+=score;await client.query(`INSERT INTO attempt_answers(attempt_id,question_id,points_awarded,reviewer_comment) VALUES($1,$2,$3,$4)
      ON CONFLICT(attempt_id,question_id) DO UPDATE SET points_awarded=EXCLUDED.points_awarded,reviewer_comment=EXCLUDED.reviewer_comment`,[a.id,q.id,score,String((b.comments||{})[q.id]||'').slice(0,1500)])}await client.query("UPDATE attempts SET status='reviewed',open_score=$1,final_score=objective_score+$1,analysis=$2,recommendation=$3,general_comment=$4,reviewed_by=$5,reviewed_at=now() WHERE id=$6",[openScore,analysis,recommendation,String(b.generalComment||'').slice(0,2000),user.id,a.id]);await client.query('COMMIT')}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}await audit(req,'attempt_reviewed','attempt',a.id);return json(res,200,{ok:true});
  }
  const releaseMatch=p.match(/^\/api\/attempts\/([\da-f-]+)\/release$/i);
  if(releaseMatch&&method==='POST'){
    if(user.role!=='superadmin')return fail(res,403,'Solo el superadministrador puede aprobar y liberar resultados.');const r=await query("UPDATE attempts SET status='released',released_by=$1,released_at=now() WHERE id=$2 AND status='reviewed' RETURNING id",[user.id,releaseMatch[1]]);if(!r.rowCount)return fail(res,409,'El análisis debe completarse antes de liberar el resultado.');await audit(req,'attempt_released','attempt',releaseMatch[1]);return json(res,200,{ok:true});
  }
  if(method==='GET'&&p==='/api/my/results'){
    if(user.role!=='candidate')return fail(res,403,'Solo candidatos pueden consultar sus resultados.');const rows=await query("SELECT a.id,a.status,a.submitted_at,a.reviewed_at,a.released_at,a.objective_score,a.objective_max,a.open_score,a.open_max,a.final_score,a.final_max,a.analysis,a.recommendation,a.general_comment,e.title AS exam_title FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE a.candidate_id=$1 AND a.status='released' ORDER BY a.released_at DESC",[user.id]);return json(res,200,{results:rows.rows});
  }
  if(method==='GET'&&p==='/api/reports'){
    if(!['superadmin','admin'].includes(user.role))return fail(res,403,'Sin permiso.');const rows=await query(`SELECT a.id,a.status,a.started_at,a.submitted_at,a.reviewed_at,a.released_at,a.objective_score,a.objective_max,a.open_score,a.open_max,a.final_score,a.final_max,a.recommendation,a.exam_id,e.title AS exam_title,u.id AS candidate_id,u.full_name AS candidate_name,u.username AS candidate_username FROM attempts a JOIN exams e ON e.id=a.exam_id JOIN users u ON u.id=a.candidate_id ORDER BY COALESCE(a.submitted_at,a.started_at) DESC LIMIT 500`);return json(res,200,{reports:rows.rows});
  }
  if(method==='GET'&&p==='/api/statistics'){
    if(!['superadmin','admin'].includes(user.role))return fail(res,403,'Sin permiso.');const examId=url.searchParams.get('examId');const params=examId?[examId]:[];const where=examId?'WHERE a.exam_id=$1':'';
    const totals=await query(`SELECT count(*)::int AS attempts,count(*) FILTER(WHERE a.status IN ('submitted','reviewed','released'))::int AS submitted,count(*) FILTER(WHERE a.status='released')::int AS released,COALESCE(round(avg(a.final_score::numeric*100/NULLIF(a.final_max,0)) FILTER(WHERE a.status='released')),0)::int AS average FROM attempts a ${where}`,params);
    const byExam=await query(`SELECT e.id,e.title,count(a.id)::int AS attempts,count(a.id) FILTER(WHERE a.status='released')::int AS released,COALESCE(round(avg(a.final_score::numeric*100/NULLIF(a.final_max,0)) FILTER(WHERE a.status='released')),0)::int AS average FROM exams e LEFT JOIN attempts a ON a.exam_id=e.id GROUP BY e.id ORDER BY e.created_at DESC`);return json(res,200,{totals:totals.rows[0],byExam:byExam.rows});
  }
  if(method==='GET'&&p==='/api/audit'){
    if(user.role!=='superadmin')return fail(res,403,'Solo el superadministrador puede consultar la bitácora.');const rows=await query(`SELECT l.*,u.username,u.full_name FROM audit_logs l LEFT JOIN users u ON u.id=l.actor_id ORDER BY l.created_at DESC LIMIT 500`);return json(res,200,{logs:rows.rows});
  }
  if(p==='/api/backups'&&method==='GET'){
    if(user.role!=='superadmin')return fail(res,403,'Solo el superadministrador puede administrar respaldos.');await fs.mkdir(BACKUP_DIR,{recursive:true});const names=(await fs.readdir(BACKUP_DIR)).filter(x=>/^examena-.*\.json\.gz$/.test(x)).sort().reverse();const backups=await Promise.all(names.map(async file=>{const stat=await fs.stat(path.join(BACKUP_DIR,file));return {file,bytes:stat.size,createdAt:stat.mtime.toISOString()}}));return json(res,200,{backups,retentionDays:BACKUP_KEEP});
  }
  if(p==='/api/backups'&&method==='POST'){
    if(user.role!=='superadmin')return fail(res,403,'Solo el superadministrador puede crear respaldos.');const backup=await createBackup();await audit(req,'backup_created','backup',backup.file);return json(res,201,{backup});
  }
  if(p==='/api/backups/restore'&&method==='POST'){
    if(user.role!=='superadmin')return fail(res,403,'Solo el superadministrador puede restaurar respaldos.');const body=await readBody(req),backup=body.backup;const order=['users','exams','questions','exam_assignments','attempts','attempt_answers','audit_logs'];if(backup?.format!=='examena-backup-v1'||!backup.tables||order.some(name=>!Array.isArray(backup.tables[name])))return fail(res,400,'El archivo no es un respaldo válido de Examena.');
    const client=await pool.connect();try{await client.query('BEGIN');await client.query('TRUNCATE TABLE sessions,audit_logs,attempt_answers,attempts,exam_assignments,questions,exams,users RESTART IDENTITY CASCADE');for(const table of order){for(const row of backup.tables[table]){const cols=Object.keys(row);if(!cols.length||cols.some(key=>!/^[a-z_]+$/.test(key)))throw new Error(`Columna no válida en respaldo: ${table}`);const vals=cols.map(key=>row[key]);const placeholders=vals.map((_,i)=>`$${i+1}`).join(',');await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`,vals)}}await client.query("SELECT setval(pg_get_serial_sequence('audit_logs','id'),COALESCE((SELECT max(id) FROM audit_logs),1),EXISTS(SELECT 1 FROM audit_logs))");await client.query('COMMIT')}catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}await audit(req,'backup_restored','backup',backup.createdAt);return json(res,200,{ok:true,restoredFrom:backup.createdAt,sessionsInvalidated:true});
  }
  const backupMatch=p.match(/^\/api\/backups\/([\w.-]+)$/);
  if(backupMatch&&method==='GET'){
    if(user.role!=='superadmin')return fail(res,403,'Solo el superadministrador puede descargar respaldos.');const filename=backupMatch[1];if(filename.includes('..')||!/^examena-.*\.json\.gz$/.test(filename))return fail(res,400,'Nombre de respaldo inválido.');const target=path.join(BACKUP_DIR,filename);if(!fsSync.existsSync(target))return fail(res,404,'Respaldo no encontrado.');res.writeHead(200,{'Content-Type':'application/gzip','Content-Disposition':`attachment; filename="${filename}"`,'Cache-Control':'no-store'});return fsSync.createReadStream(target).pipe(res);
  }

  return serveStatic(req,res,p);
}

async function serveStatic(req,res,pathname) {
  if(!['GET','HEAD'].includes(req.method))return fail(res,404,'Ruta no encontrada.');
  let decoded;try{decoded=decodeURIComponent(pathname)}catch{return fail(res,400,'Ruta inválida.')}
  const relative=decoded==='/'?'index.html':decoded.replace(/^\/+/,'');
  if(!['index.html','app.js','styles.css'].includes(relative))return fail(res,404,'No encontrado.');
  const file=path.resolve(ROOT,relative);
  try{const stat=await fs.stat(file);if(!stat.isFile())throw new Error();res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});if(req.method==='HEAD')return res.end();fsSync.createReadStream(file).pipe(res)}catch{return fail(res,404,'No encontrado.')}
}

const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  try{await route(req,res)}catch(error){console.error(error);if(!res.headersSent)json(res,error.status||500,{error:error.status?error.message:'Error interno del servidor.'});else res.end()}
});
server.requestTimeout=30_000;

async function start(){if(!process.env.DATABASE_URL)throw new Error('Configura DATABASE_URL con la URL interna de PostgreSQL.');await migrate();await ensureSuperadmin();await seedInitialExam();server.listen(PORT,'0.0.0.0',()=>console.log(`Examena lista en el puerto ${PORT}.`));backupScheduler();}
start().catch(error=>{console.error('No se pudo iniciar Examena:',error.message);process.exit(1)});
process.on('SIGTERM',async()=>{server.close();await pool.end();process.exit(0)});
