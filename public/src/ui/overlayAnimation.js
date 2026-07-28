// Phase-locking for the designer's decorative overlay animations.
//
// The Heat flow overlay and the wiring overlay are both rebuilt wholesale
// (`replaceChildren()` + fresh SVG) whenever the pointer moves enough to change
// what they show -- and the wiring overlay is rebuilt on every animation frame
// while a cable is being dragged. Every recreated element starts its infinite
// CSS animation over at time zero, so a run of rebuilds pins those animations
// near their first keyframe and they visibly stutter instead of pulsing. The
// overloaded states are the ones that show it, because they are the only
// overlay elements carrying infinite animations (the at-peak/above-sustained
// cable halos, the shortage outline over a source component, the marching
// heat-flow dashes).
//
// Anchoring each infinite animation's `startTime` to the document timeline
// origin makes its phase a pure function of wall-clock time, so a rebuilt
// element resumes exactly where its predecessor was and a rebuild becomes
// visually invisible.
//
// Finite animations are deliberately left alone: they are one-shot cues such as
// the "locate" flash, which are meant to run from the moment they are applied
// and would appear already finished if they were anchored to the timeline
// origin.
export function phaseLockOverlayAnimations(root) {
  if (!root?.getAnimations) return 0;
  let locked = 0;
  for (const animation of root.getAnimations({ subtree: true })) {
    let timing;
    try {
      timing = animation.effect?.getTiming?.();
    } catch (_) {
      continue;
    }
    if (timing?.iterations !== Infinity) continue;
    // A paused or finished animation has no phase worth preserving.
    if (animation.playState === "idle") continue;
    try {
      animation.startTime = 0;
      locked += 1;
    } catch (_) {
      // Animations on a timeline that rejects an explicit start time keep the
      // default behaviour rather than breaking the render.
    }
  }
  return locked;
}
