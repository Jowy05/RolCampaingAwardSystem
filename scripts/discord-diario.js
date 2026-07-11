'use strict';
/*
 * Aviso diario de Discord — corre en GitHub Actions (server-side), NO en el navegador.
 * Cada día ~13:00 Madrid lee Firebase (abierto) y, por cada campaña con Discord activo,
 * manda UN mensaje al webhook según el estado de la votación semanal:
 *   1) falta gente por votar        -> "faltan X por votar" (flag r/<hoy>, compartido con el cliente)
 *   2) todos votaron, sin sesión fijada -> "recuerda máster, fija sesión, top 1/2/3" (flag fija/<hoy>)
 *   3) sesión fijada
 *        - si es hoy   -> "¡HOY hay sesión!" (flag hoy/<dia>, compartido con el cliente)
 *        - si es futura-> "recordad que el X hay sesión" (flag rec/<hoy>)
 * El flag idempotente en /info/discordSent/<key> evita duplicados (con el cliente y entre reruns).
 * Toda la aritmética de fechas/semana se hace en horario CIVIL de Madrid (DST-safe vía UTC).
 */

const FB      = "https://logrospathfinder-default-rtdb.europe-west1.firebasedatabase.app";
const APP_URL = "https://jowy05.github.io/RolCampaingAwardSystem/";
const DIAS_SEM = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const HORA_MIN = 13, HORA_MAX = 20; // ventana Madrid [13..20]: envía en la 1ª ejecución a partir de las 13h. Amplia a propósito porque el cron de GitHub se retrasa (a veces 1-2h) o se omite; el flag diario garantiza 1 solo envío aunque varias ejecuciones caigan dentro.
const DRY    = String(process.env.DRY_RUN || "").toLowerCase() === "true";
const MANUAL = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";

const pad2 = n => (n < 10 ? "0" : "") + n;

// ---- fecha/hora en horario civil de Madrid ----
function madridNow() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  let h = parseInt(p.hour, 10); if (h === 24) h = 0;
  return { y: +p.year, m: +p.month, d: +p.day, h };
}
// Una fecha civil se representa como su medianoche UTC → así getUTC* da el día/semana correctos sin líos de DST.
const civil   = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const dkeyOf  = dt => dt.getUTCFullYear() + "-" + pad2(dt.getUTCMonth() + 1) + "-" + pad2(dt.getUTCDate());
const dowMon  = dt => (dt.getUTCDay() + 6) % 7;                 // 0=Lun … 6=Dom
const addDays = (dt, n) => new Date(dt.getTime() + n * 86400000);
function labelDk(dk) { const p = dk.split("-"); const dt = civil(+p[0], +p[1], +p[2]); return DIAS_SEM[dowMon(dt)] + " " + dt.getUTCDate(); }

// ---- lógica de disponibilidad (replica exacta del cliente) ----
function wdOfKey(dk) { const p = dk.split("-"); return dowMon(civil(+p[0], +p[1], +p[2])); }
function autoDe(QAUTO, m, dk) { const a = QAUTO[m]; return (a && a[wdOfKey(dk)]) || ""; }
function esExplicito(Q, dk, m) { const f = Q[dk]; return !!(f && f[m]); }
function estadoEfectivo(Q, A, dk, m) { return esExplicito(Q, dk, m) ? (Q[dk][m] || "") : autoDe(A, m, dk); }
function quienPuede(Q, A, MI, dk) { return MI.filter(m => estadoEfectivo(Q, A, dk, m) === "si"); }
function quienTalvez(Q, A, MI, dk) { return MI.filter(m => estadoEfectivo(Q, A, dk, m) === "talvez"); }
function puntosDia(Q, A, MI, dk) { return quienPuede(Q, A, MI, dk).length + quienTalvez(Q, A, MI, dk).length * 0.5; }
function haVotado(Q, A, weekKeys, m) { const a = A[m]; if (a && Object.keys(a).length) return true; return weekKeys.some(dk => esExplicito(Q, dk, m)); }

function topDias(Q, A, MI, weekDays) {
  return weekDays.map(d => { const dk = dkeyOf(d); return { dk, n: quienPuede(Q, A, MI, dk).length, tv: quienTalvez(Q, A, MI, dk).length, pts: puntosDia(Q, A, MI, dk) }; })
    .filter(x => x.pts > 0)
    .sort((a, b) => (b.pts - a.pts) || (a.dk < b.dk ? -1 : 1))
    .slice(0, 3);
}

// ---- Firebase REST (abierto, sin auth) ----
async function fbGet(path, extraQ) { try { const r = await fetch(FB + path + ".json?x=" + Date.now() + (extraQ ? "&" + extraQ : "")); return r.ok ? await r.json() : null; } catch { return null; } }
async function fbPut(path, val) { try { const r = await fetch(FB + path + ".json", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(val) }); return r.ok; } catch { return false; } }
async function fbDel(path) { try { await fetch(FB + path + ".json", { method: "DELETE" }); } catch {} }

function rolTag(rolId) { return rolId ? "<@&" + rolId + "> " : ""; }
async function discordPost(webhook, rolId, content) {
  try {
    const body = { content: String(content).slice(0, 1900), allowed_mentions: { parse: [], roles: rolId ? [String(rolId)] : [] } };
    const r = await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return r.ok;
  } catch { return false; }
}

// Función PURA: dado el estado, decide qué mensaje toca y con qué flag. Sin I/O → testeable.
function decidir(info, hoyKey, mondayKey, weekDays) {
  const c = info.discord || {};
  const gm = info.gm || "";
  const MI = Object.keys(info.miembros || {}).filter(m => m !== gm);
  if (!MI.length) return { skip: "sin miembros" };
  const Q = info.quedadas || {}, A = info.quedadasAuto || {};
  const weekKeys = weekDays.map(dkeyOf);

  const si = MI.filter(m => haVotado(Q, A, weekKeys, m));
  const no = MI.filter(m => !haVotado(Q, A, weekKeys, m));
  const dia = ((info.sesion || {})[mondayKey] || {}).dia || null;

  if (no.length > 0) {
    if (c.avisoRecord === false) return { skip: "avisoRecord=off" };
    return { key: "r/" + hoyKey, msg: rolTag(c.rolId) + `🗳️ Disponibilidad de la semana: **${si.length}/${MI.length}** han votado. Faltan por votar: **${no.join(", ")}**. Marcad vuestros días para cuadrar la sesión 👉 ${APP_URL} ¡gracias! 🙏` };
  }
  if (!dia) {
    // Solo días de hoy en adelante: no tiene sentido proponer el viernes siendo sábado.
    const tops = topDias(Q, A, MI, weekDays.filter(d => dkeyOf(d) >= hoyKey));
    const meds = ["🥇", "🥈", "🥉"];
    const lista = tops.length ? tops.map((t, i) => `${meds[i]} **${labelDk(t.dk)}** (${t.n}${t.tv ? "+" + t.tv + "🤔" : ""})`).join("   ") : "_(nadie puede ningún día aún)_";
    return { key: "fija/" + hoyKey, msg: rolTag(c.rolId) + `📅 ¡Ya habéis votado **todos**! Falta fijar la sesión.${gm ? ` **${gm}**,` : ""} toca elegir día 🎲. Días con más gente:   ${lista}` };
  }
  if (c.avisoHoy === false) return { skip: "avisoHoy=off (sesión fijada)" };
  if (dia === hoyKey) {
    return { key: "hoy/" + dia, msg: rolTag(c.rolId) + `🎲 **¡HOY HAY SESIÓN!** (${labelDk(dia)}). ¡Nos vemos! 🐉` };
  }
  return { key: "rec/" + hoyKey, msg: rolTag(c.rolId) + `🎲 ¡Recordad que **${labelDk(dia)}** hay sesión esta semana! 🐉` };
}

async function procesarCampana(id, hoyKey, mondayKey, weekDays) {
  const info = await fbGet("/campanas/" + id + "/info");
  if (!info) { console.log(`· ${id}: sin info, salto`); return; }
  const c = info.discord || {};
  if (!c.on || !c.webhook) { console.log(`· ${id}: Discord off o sin webhook, salto`); return; }

  const d = decidir(info, hoyKey, mondayKey, weekDays);
  if (d.skip) { console.log(`· ${id}: ${d.skip}, salto`); return; }
  const { key, msg } = d;

  const flagPath = "/campanas/" + id + "/info/discordSent/" + key;
  const yaEnviado = await fbGet(flagPath);

  if (DRY) { console.log(`· ${id}: [DRY] key=${key} ${yaEnviado ? "(flag YA existe → real saltaría)" : "(enviaría)"}\n    ${msg}`); return; }
  if (yaEnviado) { console.log(`· ${id}: ya enviado hoy (${key}), salto`); return; }

  const claimed = await fbPut(flagPath, { t: new Date().toISOString(), by: "cron" });
  if (!claimed) { console.log(`· ${id}: no pude reclamar el flag, salto`); return; }
  const ok = await discordPost(c.webhook, c.rolId, msg);
  if (ok) { console.log(`· ${id}: ✅ enviado (${key})`); }
  else { await fbDel(flagPath); console.log(`· ${id}: ⚠ webhook falló, flag liberado (${key})`); }
}

async function main() {
  const now = madridNow();
  console.log(`Madrid ahora: ${now.y}-${pad2(now.m)}-${pad2(now.d)} ${pad2(now.h)}h | DRY=${DRY} MANUAL=${MANUAL}`);
  if (!MANUAL && !DRY && (now.h < HORA_MIN || now.h > HORA_MAX)) { console.log(`Fuera de la ventana ${HORA_MIN}-${HORA_MAX}h Madrid — no toca. Fin.`); return; }

  const today = civil(now.y, now.m, now.d);
  const hoyKey = dkeyOf(today);
  const monday = addDays(today, -dowMon(today));
  const mondayKey = dkeyOf(monday);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(monday, i));

  const camps = await fbGet("/campanas", "shallow=true") || {};
  const ids = Object.keys(camps);
  console.log(`Campañas: ${ids.join(", ") || "(ninguna)"}`);
  for (const id of ids) { await procesarCampana(id, hoyKey, mondayKey, weekDays); if (!DRY) await podarFlags(id, today); }
  console.log("Fin.");
}

// Poda los flags propios del cron (fija/rec) de más de 30 días; el cliente ya poda r/c/dia/hoy.
async function podarFlags(id, todayCivil) {
  const sent = await fbGet("/campanas/" + id + "/info/discordSent");
  if (!sent) return;
  for (const g of ["fija", "rec"]) {
    const grp = sent[g] || {};
    for (const k of Object.keys(grp)) {
      const p = k.split("-");
      if (p.length !== 3) continue;
      const edadDias = (todayCivil - civil(+p[0], +p[1], +p[2])) / 86400000;
      if (edadDias > 30) await fbDel("/campanas/" + id + "/info/discordSent/" + g + "/" + k);
    }
  }
}

module.exports = { decidir, dkeyOf, dowMon, civil, addDays, topDias, haVotado };
if (require.main === module) main().catch(e => { console.error("ERROR:", e); process.exit(1); });
