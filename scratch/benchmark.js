const { WORLD_SIZES } = require("../src/server/config.js");

function chooseWorldSize_Original(playerCount) {
  const size = WORLD_SIZES.find((candidate) => playerCount <= candidate.maxPlayers) || WORLD_SIZES[WORLD_SIZES.length - 1];
  return { width: size.width, height: size.height, label: size.label };
}

function chooseWorldSize_Optimized1(playerCount) {
  for (let i = 0; i < WORLD_SIZES.length; i++) {
    const candidate = WORLD_SIZES[i];
    if (playerCount <= candidate.maxPlayers) {
      return { width: candidate.width, height: candidate.height, label: candidate.label };
    }
  }
  const last = WORLD_SIZES[WORLD_SIZES.length - 1];
  return { width: last.width, height: last.height, label: last.label };
}

function chooseWorldSize_Optimized2(playerCount) {
    if (playerCount <= 2) return { width: 2600, height: 1600, label: "Duel" };
    if (playerCount <= 4) return { width: 3200, height: 1900, label: "Skirmish" };
    if (playerCount <= 8) return { width: 4100, height: 2400, label: "Battle" };
    return { width: 5000, height: 2900, label: "Grand battle" };
}

const ITERATIONS = 10000000;
const testValues = [1, 2, 3, 4, 5, 8, 10, 15, 100];

console.log("Benchmarking chooseWorldSize");

let start = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
  chooseWorldSize_Original(testValues[i % testValues.length]);
}
let end = performance.now();
console.log(`Original: ${(end - start).toFixed(2)} ms`);

start = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
  chooseWorldSize_Optimized1(testValues[i % testValues.length]);
}
end = performance.now();
console.log(`Optimized (For loop): ${(end - start).toFixed(2)} ms`);

start = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
  chooseWorldSize_Optimized2(testValues[i % testValues.length]);
}
end = performance.now();
console.log(`Optimized (Direct IFs): ${(end - start).toFixed(2)} ms`);
