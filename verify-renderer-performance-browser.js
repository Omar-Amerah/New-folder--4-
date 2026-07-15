import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const ART='test-artifacts/renderer-performance'; mkdirSync(ART,{recursive:true});
const viewports=[{width:900,height:700},{width:1280,height:900},{width:1600,height:900}];
const qualities=['low','medium','high']; const dprs=[1,1.5,2];
const server=spawn(process.execPath,['server.js'],{stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:'4180'}}); let serverLog=''; server.stdout.on('data',d=>serverLog+=d); server.stderr.on('data',d=>serverLog+=d);
await new Promise(r=>setTimeout(r,1200));
const browser=await chromium.launch({headless:true}); const report=[];
try{
 for(const viewport of viewports){ for(const dpr of dprs){ const qs=qualities.filter(q=>q!=='high'||(viewport.width===1280&&dpr===1)); for(const quality of qs){
  const page=await browser.newPage({viewport, deviceScaleFactor:dpr}); const consoleErrors=[]; const pageErrors=[]; page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('WebGL context lost')) consoleErrors.push(m.text())}); page.on('pageerror',e=>pageErrors.push(e.message));
  try{
   await page.goto('http://127.0.0.1:4180',{waitUntil:'domcontentloaded'}); await page.evaluate(q=>localStorage.setItem('mfa.renderQuality',q),quality); await page.reload({waitUntil:'domcontentloaded'}); await page.waitForFunction(()=>window.__mfaMainLoaded===true&&window.__mfaRenderer?.diagnostics?.().initialized,{timeout:10000});
   await page.evaluate(()=>window.__mfaSetRendererMetricsPhase?.('warmup',{reset:true})); await page.waitForTimeout(350); await page.evaluate(()=>window.__mfaSetRendererMetricsPhase?.('steady',{reset:true}));
   for(let i=0;i<8;i++){ await page.mouse.move(180+i*35,180+i*10); await page.mouse.wheel(0,i%2?-120:120); if(i===3) await page.keyboard.press('KeyQ'); }
   await page.setViewportSize(viewport); await page.waitForTimeout(550);
   const diag=await page.evaluate(()=>window.__mfaRenderer.diagnostics()); const body=await page.locator('body').boundingBox();
   assert.equal(diag.fatalFrameError,null); assert.equal(diag.initialized,true); assert.equal(diag.webglContextState,'active'); assert.equal(diag.activeTickerCount,1); assert.ok(diag.frameMetrics.phases.steady.measuredFrames>10,'steady frames');
   assert.ok(Number.isFinite(diag.camera.x)&&Number.isFinite(diag.camera.y)&&Number.isFinite(diag.camera.zoom)); assert.ok(Math.abs(diag.cssCanvasWidth-diag.rendererWidth)<=2); assert.ok(Math.abs(diag.cssCanvasHeight-diag.rendererHeight)<=2); assert.ok(body.width<=viewport.width+1,'no horizontal overflow');
   if(quality==='low') assert.ok(diag.resolution<=1.25+0.01); if(quality==='medium') assert.ok(diag.resolution<=1.5+0.01); if(quality==='high') assert.ok(diag.resolution<=2.0+0.01);
   assert.deepEqual(consoleErrors,[]); assert.deepEqual(pageErrors,[]);
   report.push({viewport,dpr,quality,frames:diag.frameMetrics.phases.steady,visible:diag.visibleCount,culled:diag.culledCount,textures:diag.textureEntries,pools:diag.pools});
  }catch(e){ await page.screenshot({path:`${ART}/failure-${viewport.width}x${viewport.height}-dpr${dpr}-${quality}.png`,fullPage:true}).catch(()=>{}); writeFileSync(`${ART}/diagnostics.json`,JSON.stringify({report,consoleErrors,pageErrors,serverLog},null,2)); throw e; }
  finally{ await page.close(); }
 }}}
 writeFileSync(`${ART}/performance-report.json`,JSON.stringify(report,null,2)); console.log('Renderer performance browser passed',JSON.stringify(report));
} finally { await browser.close(); server.kill('SIGTERM'); writeFileSync(`${ART}/server.log`,serverLog); }
