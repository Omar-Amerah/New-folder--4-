const { WORLD_SIZES } = require("../src/server/config.js");

function chooseWorldSize_Original(playerCount) {
  const size = WORLD_SIZES.find((candidate) => playerCount <= candidate.maxPlayers) || WORLD_SIZES[WORLD_SIZES.length - 1];
  return { width: size.width, height: size.height, label: size.label };
}

function chooseWorldSize_For(playerCount) {
  for (let i = 0; i < WORLD_SIZES.length; i++) {
    const candidate = WORLD_SIZES[i];
    if (playerCount <= candidate.maxPlayers) {
      return { width: candidate.width, height: candidate.height, label: candidate.label };
    }
  }
  const last = WORLD_SIZES[WORLD_SIZES.length - 1];
  return { width: last.width, height: last.height, label: last.label };
}

function chooseWorldSize_ForOf(playerCount) {
  for (const candidate of WORLD_SIZES) {
    if (playerCount <= candidate.maxPlayers) {
      return { width: candidate.width, height: candidate.height, label: candidate.label };
    }
  }
  const last = WORLD_SIZES[WORLD_SIZES.length - 1];
  return { width: last.width, height: last.height, label: last.label };
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
  chooseWorldSize_For(testValues[i % testValues.length]);
}
end = performance.now();
console.log(`Optimized (For): ${(end - start).toFixed(2)} ms`);

start = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
  chooseWorldSize_ForOf(testValues[i % testValues.length]);
}
end = performance.now();
console.log(`Optimized (ForOf): ${(end - start).toFixed(2)} ms`);
