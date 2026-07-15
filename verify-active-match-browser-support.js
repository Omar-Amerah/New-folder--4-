import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { uniqueRoom, waitForBrowserReady } from './verify-pixi-browser-support.js';
const require = createRequire(import.meta.url);
const { validateClientMessage } = require('./src/server/clientSchemas.js');
const { validateDesign } = require('./src/server/shipDesign.js');
const { computeStats } = require('./src/server/shipStats.js');
const { PARTS } = require('./src/server/components.js');
export const CANONICAL_ACTIVE_MATCH_DESIGN = Object.freeze([
  {x:7,y:7,type:'core',rotation:0},{x:7,y:8,type:'frame',rotation:0},
  {x:6,y:8,type:'engine',rotation:0},{x:8,y:8,type:'engine',rotation:0},
  {x:6,y:7,type:'blaster',rotation:0},{x:8,y:7,type:'blaster',rotation:0},
  {x:6,y:6,type:'reactor',rotation:0},{x:8,y:6,type:'battery',rotation:0},
  {x:7,y:5,type:'heatSink',rotation:0}
]);
export function validateCanonicalDesign(design=CANONICAL_ACTIVE_MATCH_DESIGN, budget=12000){
  const schema = validateClientMessage({type:'deploy', design, combatStyle:'sentry'});
  const validation = validateDesign(design);
  const stats = computeStats(design);
  const typesOk = design.every((p)=>PARTS[p.type]);
  const result={ok:Boolean(schema.ok&&validation.ok&&typesOk&&stats.thrust>0&&stats.power>=0&&stats.unitCost<=budget&&(stats.blaster+stats.missile+stats.railgun)>0),schema,validation,stats,componentTypes:design.map((p,i)=>({index:i,type:p.type,valid:Boolean(PARTS[p.type])}))};
  if(!result.ok){
    const invalid=result.componentTypes.find(c=>!c.valid)||{};
    throw new Error(`canonical design preflight failed: ${JSON.stringify({componentIndex:invalid.index,componentType:invalid.type,validationCode:schema.code||null,validationReason:schema.message||validation.reason||null,computedCost:stats.unitCost,generatedPower:stats.powerGeneration,powerUse:stats.powerUse,engineThrust:stats.thrust,connected:validation.ok&&!/connect/.test(validation.reason||''),overlapOk:validation.ok&&!/overlap/.test(validation.reason||''),componentTypes:result.componentTypes},null,2)}`);
  }
  return result;
}
export function normalizeRendererDiagnostics(d={}){return {authoritativeShips:d.authoritativeShipCount??0,visualShips:d.visualShipCount??0,activeShipViews:d.pools?.ships?.activeShipViews??0,idleShipViews:d.pools?.ships?.freeShipViews??0,textureEntries:d.textureEntries??0,tickerCount:d.activeTickerCount??0,applicationGeneration:d.applicationGeneration??0,contextState:d.webglContextState??null,initialized:Boolean(d.initialized),raw:d};}
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
export async function waitOutcome(page, predicate, timeoutMs, label){const cursors=await page.evaluate(()=>{const d=window.__mfaNetworkDiagnostics||{}; const max=(a)=>Array.isArray(a)?Math.max(0,...a.map(e=>e.id||0)):0; return {error:max(d.latestErrors),notice:max(d.latestNotices),close:max(d.socketCloses),accepted:d.latestAcceptedSnapshotEventId||0};}); const start=Date.now();let last;while(Date.now()-start<timeoutMs){last=await page.evaluate(()=>({url:location.href,room:window.__mfaState?.room||null,readyState:window.__mfaState?.socket?.readyState??null,generation:window.__mfaState?.connectionGeneration??null,reconnect:window.__mfaState?.reconnect||null,myId:window.__mfaState?.myId||null,adminId:window.__mfaState?.adminId||null,phase:window.__mfaState?.phase||null,players:window.__mfaState?.snapshot?.players?.map(p=>({id:p.id,name:p.name,ready:p.ready,bot:p.bot}))||[],snapshotSequence:window.__mfaState?.snapshotNetwork?.snapshotSeq??null,stateEpoch:window.__mfaState?.snapshotNetwork?.stateEpoch??null,snapshotKind:window.__mfaState?.snapshotNetwork?.lastSnapshotKind??null,shipCount:window.__mfaState?.snapshot?.ships?.length??0,network:window.__mfaNetworkDiagnostics||{},renderer:window.__mfaRenderer?.diagnostics?.()||null})); if(await predicate(last)) return last; const newErrors=(last.network?.latestErrors||[]).filter(e=>(e.id||0)>cursors.error); if(newErrors.length) throw new Error(`${label} failed with protocol error: ${JSON.stringify({...last,newErrors},null,2)}`); const newCloses=(last.network?.socketCloses||[]).filter(e=>(e.id||0)>cursors.close); if(last.readyState===3||newCloses.length) throw new Error(`${label} failed: socket closed ${JSON.stringify({...last,newCloses},null,2)}`); await sleep(150);} throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last,null,2)}`);}
export async function setupActiveMatch(page,{baseUrl,room=uniqueRoom('act'),bots=3,startingMoney=12000,requireAdmin=true,design=CANONICAL_ACTIVE_MATCH_DESIGN,scenario='active'}={}){
  const designValidation=validateCanonicalDesign(design,startingMoney);
  await page.goto(`${baseUrl}/index.html?room=${room}`,{waitUntil:'load'});
  await waitForBrowserReady(page, room, {}, 20000);
  const joined=await waitOutcome(page, s=>s.myId&&(!requireAdmin||s.myId===s.adminId),10000,`${scenario}: joined/admin`);
  await page.evaluate((money)=>window.__mfaNetSend({type:'setRules',rules:{asteroidDensity:'low',startingMoney:money}}),startingMoney);
  for(let i=0;i<bots;i++) await page.evaluate(()=>window.__mfaNetSend({type:'addBot'}));
  await page.evaluate(()=>window.__mfaNetSend({type:'startDesign'}));
  await waitOutcome(page,s=>s.phase==='design'&&s.players.length>=bots+1,10000,`${scenario}: design phase`);
  await page.evaluate((d)=>window.__mfaNetSend({type:'deploy',design:d,combatStyle:'sentry'}),design);
  await waitOutcome(page,s=>s.players.some(p=>p.id===s.myId&&p.ready) || s.phase==='active',10000,`${scenario}: deploy accepted`);
  const active=await waitOutcome(page,s=>s.phase==='active'&&s.shipCount>0,20000,`${scenario}: active ships`);
  await waitOutcome(page,s=>normalizeRendererDiagnostics(s.renderer).contextState==='active'&&normalizeRendererDiagnostics(s.renderer).activeShipViews>0&&normalizeRendererDiagnostics(s.renderer).textureEntries>0,15000,`${scenario}: pixi ship views`);
  const renderer=await page.evaluate(()=>window.__mfaRenderer.diagnostics());
  return {room,playerId:active.myId,botIds:active.players.filter(p=>p.bot).map(p=>p.id),shipIds:(await page.evaluate(()=>window.__mfaState.snapshot.ships.map(s=>s.id))),world:await page.evaluate(()=>window.__mfaState.world),stateEpoch:active.stateEpoch,snapshotSequence:active.snapshotSequence,rendererDiagnostics:normalizeRendererDiagnostics(renderer),designValidation,joined};
}
export async function writeFailureArtifacts(page,dir,data){mkdirSync(dir,{recursive:true}); await page?.screenshot?.({path:`${dir}/failure.png`,fullPage:true}).catch(()=>{}); const dump=await page?.evaluate?.(()=>({network:window.__mfaNetworkDiagnostics||{},renderer:window.__mfaRenderer?.diagnostics?.()||null,state:{url:location.href,room:window.__mfaState?.room,phase:window.__mfaState?.phase,myId:window.__mfaState?.myId,adminId:window.__mfaState?.adminId,players:window.__mfaState?.snapshot?.players?.map(p=>({id:p.id,name:p.name,ready:p.ready,bot:p.bot})),snapshotNetwork:window.__mfaState?.snapshotNetwork,shipCount:window.__mfaState?.snapshot?.ships?.length}})).catch(e=>({artifactError:e.message})); writeFileSync(`${dir}/diagnostics.json`,JSON.stringify({...data,...dump},null,2));}
