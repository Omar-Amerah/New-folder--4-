// Real Chromium renderer/input smoke. Reuses production build/server and WebGL Pixi path coverage.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const viewports=[process.env.MFA_VIEWPORT?JSON.parse(process.env.MFA_VIEWPORT):null].filter(Boolean);
if(!viewports.length) viewports.push({width:900,height:700},{width:1280,height:900},{width:1600,height:900});
const server=spawn(process.execPath,['server.js'],{stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:'4177'}});
let logs=''; server.stdout.on('data',d=>logs+=d); server.stderr.on('data',d=>logs+=d);
await new Promise(r=>setTimeout(r,1200));
const browser=await chromium.launch({headless:true});
try{
 for(const viewport of viewports){
  const page=await browser.newPage({viewport}); const errors=[]; page.on('pageerror',e=>errors.push(e.message)); page.on('console',m=>{ if(m.type()==='error') errors.push(m.text()); });
  await page.goto('http://127.0.0.1:4177',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__mfaMainLoaded===true);
  const canvas=await page.locator('#arenaCanvas'); await assert.doesNotReject(()=>canvas.waitFor({state:'visible',timeout:5000}));
  await page.evaluate(async()=>{ await window.__mfaRenderer?.diagnostics?.(); });
  await page.mouse.move(200,200); await page.mouse.wheel(0,-240); await page.mouse.down({button:'middle'}); await page.mouse.move(250,230); await page.mouse.up({button:'middle'});
  await page.keyboard.press('KeyF'); await page.keyboard.press('Escape'); await page.keyboard.press('KeyQ');
  const diag=await page.evaluate(()=>window.__mfaRenderer?.diagnostics?.()||{});
  assert.equal(diag.initialized,true,`renderer initialized ${viewport.width}x${viewport.height}`); assert.equal(diag.fatalFrameError,null); assert.equal(errors.length,0,errors.join('\n'));
  await page.close(); console.log(`Renderer input browser viewport ${viewport.width}x${viewport.height} passed`);
 }
} finally { await browser.close(); server.kill('SIGTERM'); }
