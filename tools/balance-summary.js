#!/usr/bin/env node
const { BALANCE } = require('../src/server/balanceConfig');
function n(v){return Number.isFinite(Number(v))?Number(v):0}
console.log('Gameplay balance summary (neutral, informational)');
console.log('\nComponents:');
for (const c of BALANCE.components) {
  const w=c.weapon||{}; const dps=n(w.damage)*n(w.fireRate);
  console.log(`- ${c.name||c.id} [${c.category}] cost=${n(c.cost)} mass=${n(c.mass)} hull=${n(c.hull??c.hp)} power +${n(c.powerGeneration)}/-${n(c.powerUse)} shield=${n(c.shield)} regen=${n(c.shieldRegen)} thrust=${n(c.thrust)} turn=${n(c.turn)} heat=${n(c.heat)} repair=${n(c.repairRate??c.repair)} weapon=${w.family||w.type||'none'} damage=${n(w.damage)} fireRate=${n(w.fireRate)} theoreticalDps=${dps.toFixed(2)} range=${n(w.range)} projectileSpeed=${n(w.projectileSpeed)} accuracy=${n(w.accuracy)} tracking=${n(w.tracking)} trackingDelay=${n(w.trackingDelay)} trackingDuration=${n(w.trackTime)} arc=${n(w.arc)}`);
}
console.log('\nShip pricing:', JSON.stringify(BALANCE.shipPricing));
console.log('Economy:', JSON.stringify(BALANCE.economy));
console.log('Rewards:', JSON.stringify(BALANCE.rewards));
console.log('Fleet cap:', BALANCE.economy.shipCap);
