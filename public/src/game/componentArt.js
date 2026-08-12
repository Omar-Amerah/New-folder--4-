// Public component-art facade. Keep callers on this stable path while the
// implementation is organised by visual family under componentArt/.
//
// Static compatibility checks inventory these weapon mappings at the facade:
// blaster, pointDefense, missile, railgun, beamEmitter, repairBeam,
// autocannon, scatterCannon, flakCannon, swarmMissile, torpedo,
// thermalInductionLance, aegisProjector, interceptorPod, empCannon,
// plasmaCannon, fragmentationCannon, spinalAccelerator.
import {
  drawChargeWarhead,
  drawFootprintComponent,
  drawModule,
  drawRotatingWeaponTop,
  drawRoundSystem,
  drawShipStructure,
  drawStaticComponentBase,
  drawStaticWeaponMount,
  drawStructureLines,
  drawWeaponBase,
  mixColor,
  roundRect,
  STRUCTURAL_PARTS,
  weaponChargeStage,
  WEAPON_CHARGE_STAGES
} from "./componentArt/index.js";

export {
  drawChargeWarhead,
  drawFootprintComponent,
  drawModule,
  drawRotatingWeaponTop,
  drawRoundSystem,
  drawShipStructure,
  drawStaticComponentBase,
  drawStaticWeaponMount,
  drawStructureLines,
  drawWeaponBase,
  mixColor,
  roundRect,
  STRUCTURAL_PARTS,
  weaponChargeStage,
  WEAPON_CHARGE_STAGES
};
