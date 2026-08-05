import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const server=spawn(process.execPath,['server.js'],{stdio:'ignore',env:{...process.env,PORT:'4178'}}); await new Promise(r=>setTimeout(r,1200));
const browser=await chromium.launch({headless:true});
try{ const page=await browser.newPage({viewport:{width:900,height:700}}); await page.goto('http://127.0.0.1:4178',{waitUntil:'domcontentloaded'}); await page.waitForFunction(()=>window.__mfaMainLoaded===true);
 for(let i=0;i<12;i++){ await page.mouse.move(200+i*10,200); await page.mouse.wheel(0,i%2?-120:120); await page.mouse.down({button:'middle'}); await page.mouse.move(260,240); await page.mouse.up({button:'middle'}); await page.setViewportSize(i%2?{width:1280,height:900}:{width:900,height:700}); }
 const diag=await page.evaluate(()=>window.__mfaRenderer?.diagnostics?.()||{}); assert.equal(diag.fatalFrameError,null); assert.equal(diag.initialized,true); console.log('Renderer interaction soak passed', JSON.stringify({visualShipCount:diag.visualShipCount, authoritativeShipCount:diag.authoritativeShipCount, input:diag.input}));
} finally { await browser.close(); server.kill('SIGTERM'); }
