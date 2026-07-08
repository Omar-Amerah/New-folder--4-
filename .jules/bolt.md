## 2024-07-07 - Avoid Math.hypot in N^2 loops
**Learning:** `Math.hypot` is a significant bottleneck in N^2 collision and targeting loops due to its overhead compared to simple squared distance checks (`dx*dx + dy*dy`). In Node.js/V8, `Math.hypot` handles multiple arguments and prevents overflow/underflow, which makes it far slower than a simple algebraic square sum check.
**Action:** When iterating over all pairs of entities (e.g., ships vs ships, ships vs bullets), always compare squared distances first and only take `Math.sqrt()` if an actual collision or range check passes and the exact distance is required for resolution.
## Performance Optimizations - Array.prototype.find vs for loop

When doing simple lookups on arrays like `WORLD_SIZES` that are evaluated very frequently, replacing `Array.prototype.find()` with a standard `for` loop significantly improves performance by reducing overhead like function calls and closures. Benchmarking showed an ~80% reduction in execution time for finding an item.
