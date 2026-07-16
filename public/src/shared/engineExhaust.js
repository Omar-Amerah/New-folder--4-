(function initEngineExhaust(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.EngineExhaustRules = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function makeEngineExhaustRules() {
  "use strict";
  const GRID_SIZE = 15;
  function rotation(value) { const n = Number(value); return [0,90,180,270].includes(n) ? n : 0; }
  function occupiedCells(module, footprint) {
    const cells = [], width = footprint?.width || 1, height = footprint?.height || 1, angle = rotation(module.rotation);
    for (let dy=0;dy<height;dy+=1) for (let dx=0;dx<width;dx+=1) {
      let ox=dx, oy=dy;
      if (angle===90) { ox=-dy; oy=dx; }
      else if (angle===180) { ox=-dx; oy=-dy; }
      else if (angle===270) { ox=dy; oy=-dx; }
      cells.push({x:module.x+ox,y:module.y+oy});
    }
    return cells;
  }
  function exhaustDirection(angle) {
    const normalized=rotation(angle);
    if (normalized===90) return {x:-1,y:0};
    if (normalized===180) return {x:0,y:-1};
    if (normalized===270) return {x:1,y:0};
    return {x:0,y:1};
  }
  function analyze(design, parts, options={}) {
    const alive = options.alive || design.map(() => true);
    const gridSize = options.gridSize || GRID_SIZE;
    const owner = new Map(), cellsByIndex=[];
    for (let i=0;i<design.length;i+=1) {
      const cells=occupiedCells(design[i],parts[design[i].type]?.footprint);
      cellsByIndex[i]=cells;
      if (alive[i]!==false) for (const cell of cells) owner.set(`${cell.x},${cell.y}`,i);
    }
    const engines=new Map();
    for (let i=0;i<design.length;i+=1) {
      const module=design[i], part=parts[module.type]||{};
      if (!((part.thrust>0) || module.type === "maneuverThruster") || alive[i]===false) continue;
      const exhaust=exhaustDirection(module.rotation), thrust={x:exhaust.x===0?0:-exhaust.x,y:exhaust.y===0?0:-exhaust.y};
      const own=new Set(cellsByIndex[i].map(cell=>`${cell.x},${cell.y}`));
      const nozzleCells=cellsByIndex[i].filter(cell=>!own.has(`${cell.x+exhaust.x},${cell.y+exhaust.y}`));
      const channelCells=[], blockers=new Set(), blockedCells=[];
      for (const nozzle of nozzleCells) {
        let x=nozzle.x+exhaust.x,y=nozzle.y+exhaust.y;
        while (x>=0&&x<gridSize&&y>=0&&y<gridSize) {
          const blocker=owner.get(`${x},${y}`);
          channelCells.push({x,y,blocked:blocker!==undefined&&blocker!==i});
          if (blocker!==undefined&&blocker!==i) { blockers.add(blocker);blockedCells.push({x,y,index:blocker}); }
          x+=exhaust.x;y+=exhaust.y;
        }
      }
      engines.set(i,{index:i,valid:blockers.size===0,exhaust,thrust,nozzleCells,channelCells,blockerIndices:[...blockers],blockedCells});
    }
    return {engines,validEngineIndices:new Set([...engines].filter(([,entry])=>entry.valid).map(([index])=>index)),blockedEngineIndices:new Set([...engines].filter(([,entry])=>!entry.valid).map(([index])=>index))};
  }
  return Object.freeze({GRID_SIZE,occupiedCells,exhaustDirection,analyze});
}));
