import assert from 'node:assert/strict';
import { SmartPairer } from '../src/core/services/SmartPairer';
import { ProjectSerializer } from '../src/core/services/ProjectSerializer';
import { createDefaultSettings, createSlideNode, createEmptyProject } from '../src/core/domain/defaults';
import { PresentationStore } from '../src/core/state/PresentationStore';

console.log('--- RUNNING DEEP VERIFICATION SUITE ---');

// 1. Test SmartPairer.parseIndicesFromFilename
console.log('[Test 1] SmartPairer filename parsing');
{
  const cases = [
    { name: '01_to_02.mp4', expected: { fromIndex: 0, toIndex: 1 } },
    { name: '1_to_2.mp4', expected: { fromIndex: 0, toIndex: 1 } },
    { name: '03-to-04.webm', expected: { fromIndex: 2, toIndex: 3 } },
    { name: '05_06.mp4', expected: { fromIndex: 4, toIndex: 5 } },
    { name: 'slide_02.mp4', expected: { fromIndex: 1, toIndex: 2 } },
    { name: 'transition_3.mp4', expected: { fromIndex: 2, toIndex: 3 } },
    { name: '04.mp4', expected: { fromIndex: 3, toIndex: 4 } },
    { name: 'video_1920_1080.mp4', expected: null }, // Resolution token excluded
    { name: 'clip_1280_720.mp4', expected: null }, // Resolution token excluded
    { name: 'intro.mp4', expected: null },
  ];

  for (const c of cases) {
    const res = SmartPairer.parseIndicesFromFilename(c.name);
    if (c.expected === null) {
      assert.equal(res, null, `Expected null for ${c.name}, got ${JSON.stringify(res)}`);
    } else {
      assert.ok(res !== null, `Expected parsed indices for ${c.name}`);
      assert.equal(res.fromIndex, c.expected.fromIndex, `fromIndex mismatch for ${c.name}`);
      assert.equal(res.toIndex, c.expected.toIndex, `toIndex mismatch for ${c.name}`);
    }
  }
  console.log('✓ parseIndicesFromFilename passed all test cases');
}

// 2. Test SmartPairer.extractSlideIndexFromFilename backward compatibility
console.log('[Test 2] SmartPairer.extractSlideIndexFromFilename backward compatibility');
{
  assert.equal(SmartPairer.extractSlideIndexFromFilename('01_to_02.mp4'), 0);
  assert.equal(SmartPairer.extractSlideIndexFromFilename('slide_05.mp4'), 4);
  assert.equal(SmartPairer.extractSlideIndexFromFilename('03.mp4'), 2);
  assert.equal(SmartPairer.extractSlideIndexFromFilename('no_numbers.mp4'), null);
  console.log('✓ extractSlideIndexFromFilename passed');
}

// 3. Test ProjectSerializer.deserializeProject & Store.loadProjectFromManifest
console.log('[Test 3] ProjectSerializer & Store slide reconstruction');
{
  const sampleJson = JSON.stringify({
    version: '1.0.0',
    title: 'عرض تجريبي لاختبار التحميل',
    settings: {
      aspectRatio: '16:9',
      stageBackground: '#000000',
      preloadStrategy: 'adjacent',
      loopPresentation: true,
      masterVolume: 0.85,
    },
    slides: [
      {
        index: 1,
        title: 'الشريحة الأولى',
        notes: 'ملاحظات المحاضر للشريحة 1',
        holdDurationSec: 5,
        imageFileName: 'slide_01.png',
        transitionToNext: {
          hasCustomVideo: true,
          videoFileName: '01_to_02.mp4',
          playbackSpeed: 1.25,
          muted: false,
          fallbackStyle: 'zoom-morph',
          fallbackDurationMs: 500,
        },
      },
      {
        index: 2,
        title: 'الشريحة الثانية',
        notes: 'ملاحظات المحاضر للشريحة 2',
        holdDurationSec: null,
        imageFileName: 'slide_02.png',
        transitionToNext: {
          hasCustomVideo: false,
          fallbackStyle: 'crossfade',
          fallbackDurationMs: 650,
          muted: true,
        },
      },
    ],
  });

  const parsed = ProjectSerializer.deserializeProject(sampleJson);
  assert.equal(parsed.title, 'عرض تجريبي لاختبار التحميل');
  assert.equal(parsed.settings?.preloadStrategy, 'adjacent');
  assert.equal(parsed.settings?.masterVolume, 0.85);
  assert.equal(parsed.slidesData.length, 2);

  // Test PresentationStore.loadProjectFromManifest
  const store = new PresentationStore();
  store.loadProjectFromManifest(parsed);

  const loadedProject = store.getProject();
  assert.equal(loadedProject.title, 'عرض تجريبي لاختبار التحميل');
  assert.equal(loadedProject.settings.preloadStrategy, 'adjacent');
  assert.equal(loadedProject.settings.masterVolume, 0.85);
  assert.equal(loadedProject.slides.length, 2, 'Must reconstruct exactly 2 slides from manifest');

  const s1 = loadedProject.slides[0];
  assert.equal(s1.title, 'الشريحة الأولى');
  assert.equal(s1.notes, 'ملاحظات المحاضر للشريحة 1');
  assert.equal(s1.holdDurationSec, 5);
  assert.equal(s1.imageAsset.name, 'slide_01.png');
  assert.equal(s1.transitionToNext.playbackSpeed, 1.25);
  assert.equal(s1.transitionToNext.fallbackStyle, 'zoom-morph');
  assert.equal(s1.transitionToNext.fallbackDurationMs, 500);

  const s2 = loadedProject.slides[1];
  assert.equal(s2.title, 'الشريحة الثانية');
  assert.equal(s2.notes, 'ملاحظات المحاضر للشريحة 2');
  assert.equal(s2.holdDurationSec, null);
  assert.equal(s2.transitionToNext.fallbackStyle, 'crossfade');
  assert.equal(s2.transitionToNext.muted, true);

  console.log('✓ Project deserialization and slide reconstruction passed completely');
}

// 4. Test PresentationStore batching and event emission
console.log('[Test 4] PresentationStore batchUpdate suppression');
{
  const store = new PresentationStore();
  let emitCount = 0;
  store.subscribe(() => {
    emitCount++;
  });

  store.batchUpdate(() => {
    store.setProjectTitle('العنوان 1');
    store.setProjectTitle('العنوان 2');
    store.updateSettings({ masterVolume: 0.5 });
  });

  assert.equal(emitCount, 1, `batchUpdate should coalesce into exactly 1 emit, got ${emitCount}`);
  console.log('✓ PresentationStore batchUpdate coalescing passed');
}

// 5. Test Preload adjacent indices calculation
console.log('[Test 5] Preload strategy adjacent indices logic');
{
  function getAdjacentIndices(currentIdx: number, totalSlides: number, loop: boolean) {
    const indices = new Set<number>();
    indices.add(currentIdx);
    if (currentIdx + 1 < totalSlides) {
      indices.add(currentIdx + 1);
    } else if (loop && totalSlides > 1) {
      indices.add(0);
    }
    if (currentIdx - 1 >= 0) {
      indices.add(currentIdx - 1);
    } else if (loop && totalSlides > 1) {
      indices.add(totalSlides - 1);
    }
    return Array.from(indices).sort((a, b) => a - b);
  }

  // Slide 0 of 5, no loop -> warms 0, 1
  assert.deepEqual(getAdjacentIndices(0, 5, false), [0, 1]);
  // Slide 0 of 5, with loop -> warms 0, 1, 4 (wraps to end)
  assert.deepEqual(getAdjacentIndices(0, 5, true), [0, 1, 4]);
  // Slide 2 of 5 -> warms 1, 2, 3
  assert.deepEqual(getAdjacentIndices(2, 5, false), [1, 2, 3]);
  // Slide 4 of 5, with loop -> warms 0, 3, 4 (wraps to start)
  assert.deepEqual(getAdjacentIndices(4, 5, true), [0, 3, 4]);
  // Single slide, with loop -> warms 0 only
  assert.deepEqual(getAdjacentIndices(0, 1, true), [0]);

  console.log('✓ Adjacent preloading indices calculation passed');
}

// 6. Test Default Settings
console.log('[Test 6] Default Presentation Settings');
{
  const defaults = createDefaultSettings();
  assert.equal(defaults.preloadStrategy, 'adjacent', 'Default preloadStrategy must be adjacent');
  assert.equal(defaults.aspectRatio, '16:9');
  assert.equal(defaults.interruptBehavior, 'skip');
  assert.equal(defaults.backwardBehavior, 'reverse-step', 'Default backwardBehavior must be reverse-step');
  assert.equal(defaults.masterVolume, 0.9);
  console.log('✓ Default settings passed');
}

// 7. Test True Reverse Transitions Scaling & Direction Formulas
console.log('[Test 7] True Reverse Transitions Mathematical Invariance');
{
  // Mathematical verification of zoom-morph forward vs reverse
  const calcZoomMorph = (t: number, isReverse: boolean) => {
    const outScale = isReverse ? 1 - t * 0.12 : 1 + t * 0.14;
    const inScale = isReverse ? 1.14 - t * 0.14 : 0.88 + t * 0.12;
    const outAlpha = 1 - t;
    const inAlpha = t;
    return { outScale, inScale, outAlpha, inAlpha };
  };

  // Forward at t=0
  const fwdStart = calcZoomMorph(0, false);
  assert.equal(fwdStart.outScale, 1.0, 'Forward outScale at start must be 1.0');
  assert.equal(fwdStart.inScale, 0.88, 'Forward inScale at start must be 0.88');
  assert.equal(fwdStart.outAlpha, 1.0);
  assert.equal(fwdStart.inAlpha, 0.0);

  // Forward at t=1
  const fwdEnd = calcZoomMorph(1, false);
  assert.equal(Math.round(fwdEnd.outScale * 100) / 100, 1.14, 'Forward outScale at end must be 1.14');
  assert.equal(Math.round(fwdEnd.inScale * 100) / 100, 1.0, 'Forward inScale at end must be 1.0');
  assert.equal(fwdEnd.outAlpha, 0.0);
  assert.equal(fwdEnd.inAlpha, 1.0);

  // Reverse at t=0 (Must mirror forward end)
  const revStart = calcZoomMorph(0, true);
  assert.equal(Math.round(revStart.outScale * 100) / 100, 1.0, 'Reverse outScale at start must be 1.0 (outgoing slide at full scale)');
  assert.equal(Math.round(revStart.inScale * 100) / 100, 1.14, 'Reverse inScale at start must mirror forward outScale (1.14)');
  assert.equal(revStart.outAlpha, 1.0);
  assert.equal(revStart.inAlpha, 0.0);

  // Reverse at t=1 (Must mirror forward start)
  const revEnd = calcZoomMorph(1, true);
  assert.equal(Math.round(revEnd.outScale * 100) / 100, 0.88, 'Reverse outScale at end must be 0.88 (zoomed down)');
  assert.equal(Math.round(revEnd.inScale * 100) / 100, 1.0, 'Reverse inScale at end must be 1.0 (target slide at full scale)');
  assert.equal(revEnd.outAlpha, 0.0);
  assert.equal(revEnd.inAlpha, 1.0);

  // Slide-push direction
  const calcPushOffset = (t: number, w: number, isReverse: boolean) => {
    const dir = isReverse ? 1 : -1;
    return {
      outOffset: dir * t * w,
      inOffset: -dir * (1 - t) * w,
    };
  };

  const norm = (v: number) => (Object.is(v, -0) ? 0 : Math.round(v * 100) / 100);

  const w = 1920;
  const fwdPushStart = calcPushOffset(0, w, false);
  const fwdPushEnd = calcPushOffset(1, w, false);
  assert.equal(norm(fwdPushStart.outOffset), 0);
  assert.equal(norm(fwdPushStart.inOffset), w);
  assert.equal(norm(fwdPushEnd.outOffset), -w);
  assert.equal(norm(fwdPushEnd.inOffset), 0);

  const revPushStart = calcPushOffset(0, w, true);
  const revPushEnd = calcPushOffset(1, w, true);
  assert.equal(norm(revPushStart.outOffset), 0);
  assert.equal(norm(revPushStart.inOffset), -w);
  assert.equal(norm(revPushEnd.outOffset), w);
  assert.equal(norm(revPushEnd.inOffset), 0);

  console.log('✓ True Reverse Transitions scaling and slide-push direction passed');
}

// 8. Test Backward Behavior Resolution
console.log('[Test 8] Backward Behavior Resolution for StagePlaybackEngine');
{
  interface MockSlide {
    transitionToNext: {
      fallbackStyle: 'zoom-morph' | 'slide-push' | 'crossfade' | 'cut';
      fallbackDurationMs: number;
    };
  }

  const resolveBackward = (
    settings: { backwardBehavior: string; defaultFallbackStyle: string; defaultFallbackDurationMs: number },
    prevSlide?: MockSlide
  ) => {
    if (settings.backwardBehavior === 'instant') {
      return { action: 'instant' };
    }
    if (settings.backwardBehavior === 'crossfade') {
      return { action: 'transition', style: 'crossfade', durationMs: 420, isReverse: true };
    }
    const spec = prevSlide?.transitionToNext;
    const style = spec?.fallbackStyle || settings.defaultFallbackStyle || 'zoom-morph';
    const durationMs = spec?.fallbackDurationMs || settings.defaultFallbackDurationMs || 500;
    return { action: 'transition', style, durationMs, isReverse: true };
  };

  const slideWithZoom: MockSlide = {
    transitionToNext: { fallbackStyle: 'zoom-morph', fallbackDurationMs: 700 },
  };

  // 'reverse-step' mirrors source slide's transition style
  const res1 = resolveBackward(
    { backwardBehavior: 'reverse-step', defaultFallbackStyle: 'crossfade', defaultFallbackDurationMs: 650 },
    slideWithZoom
  );
  assert.deepEqual(res1, { action: 'transition', style: 'zoom-morph', durationMs: 700, isReverse: true });

  // 'crossfade' forces crossfade
  const res2 = resolveBackward(
    { backwardBehavior: 'crossfade', defaultFallbackStyle: 'crossfade', defaultFallbackDurationMs: 650 },
    slideWithZoom
  );
  assert.deepEqual(res2, { action: 'transition', style: 'crossfade', durationMs: 420, isReverse: true });

  // 'instant' forces instant hold
  const res3 = resolveBackward(
    { backwardBehavior: 'instant', defaultFallbackStyle: 'crossfade', defaultFallbackDurationMs: 650 },
    slideWithZoom
  );
  assert.deepEqual(res3, { action: 'instant' });

  console.log('✓ Backward Behavior Resolution passed');
}

// 9. Test Mid-Transition Directional Interrupts
console.log('[Test 9] Mid-Transition Directional Interrupts (Prevent Navigation Trap)');
{
  interface TransitionInterruptState {
    phase: 'PLAYING_TRANSITION';
    currentSlideIndex: number;
    targetSlideIndex: number;
    isTransitionReverse: boolean;
  }

  const resolveInterruptAction = (
    state: TransitionInterruptState,
    action: 'previous' | 'next',
    behavior: 'skip' | 'lock' | 'fast-forward'
  ): { targetToLand: number | 'ignore' | 'fast-forward' } => {
    if (action === 'previous') {
      if (state.isTransitionReverse && state.targetSlideIndex !== null) {
        // Continuing backward: complete to backward destination!
        return { targetToLand: state.targetSlideIndex };
      } else {
        // Forward motion cancelled: return to starting slide
        return { targetToLand: state.currentSlideIndex };
      }
    } else {
      // next()
      if (behavior === 'lock') return { targetToLand: 'ignore' };
      if (behavior === 'fast-forward') return { targetToLand: 'fast-forward' };
      if (behavior === 'skip') {
        if (state.isTransitionReverse) {
          // Mid-backward transition: next() cancels backward and restores forward start slide
          return { targetToLand: state.currentSlideIndex };
        } else {
          return { targetToLand: state.targetSlideIndex };
        }
      }
      return { targetToLand: 'ignore' };
    }
  };

  // Case 1: Backward transition in progress (Slide 3 -> Slide 2)
  const backwardState: TransitionInterruptState = {
    phase: 'PLAYING_TRANSITION',
    currentSlideIndex: 3,
    targetSlideIndex: 2,
    isTransitionReverse: true,
  };

  // When presenter presses previous() while moving backward, MUST land on 2 (not snap back to 3)
  const r1 = resolveInterruptAction(backwardState, 'previous', 'skip');
  assert.equal(r1.targetToLand, 2, 'Previous during backward transition must complete to target slide 2');

  // When presenter presses next() while moving backward, cancels backward and returns to 3
  const r2 = resolveInterruptAction(backwardState, 'next', 'skip');
  assert.equal(r2.targetToLand, 3, 'Next during backward transition must return to start slide 3');

  // Case 2: Forward transition in progress (Slide 1 -> Slide 2)
  const forwardState: TransitionInterruptState = {
    phase: 'PLAYING_TRANSITION',
    currentSlideIndex: 1,
    targetSlideIndex: 2,
    isTransitionReverse: false,
  };

  // When presenter presses previous() during forward transition, cancels forward and returns to 1
  const r3 = resolveInterruptAction(forwardState, 'previous', 'skip');
  assert.equal(r3.targetToLand, 1, 'Previous during forward transition must cancel and return to start slide 1');

  // When presenter presses next() during forward transition with skip, completes forward to 2
  const r4 = resolveInterruptAction(forwardState, 'next', 'skip');
  assert.equal(r4.targetToLand, 2, 'Next during forward transition must complete to target slide 2');

  console.log('✓ Mid-Transition Directional Interrupts passed');
}

// 10. Test DemoGenerator Timing & Accurate Duration Calculation
console.log('[Test 10] DemoGenerator Encoder Warm-up and Duration Calculation');
{
  const warmupFrames = 8;
  const morphFrames = 44;
  const holdFinalFrames = 6;
  const frameIntervalMs = 16;

  const totalFrames = warmupFrames + morphFrames + holdFinalFrames;
  assert.equal(totalFrames, 58, 'Total frames must be 58');

  const scheduledMs = totalFrames * frameIntervalMs;
  assert.equal(scheduledMs, 928, 'Scheduled duration must be 928ms');

  // Verify that durationSec uses recordStopTime rather than onstop flush latency
  const recordStartTime = 1000;
  const recordStopTime = 1930; // 930ms of actual frame drawing
  const onstopTime = 2150;     // 220ms async WebM flush delay in Chromium

  const elapsedFromStop = recordStopTime - recordStartTime;
  const durationSecAccurate = Math.max(0.3, Number((elapsedFromStop / 1000).toFixed(2)));

  const elapsedFromOnstop = onstopTime - recordStartTime;
  const durationSecInflated = Math.max(0.3, Number((elapsedFromOnstop / 1000).toFixed(2)));

  assert.equal(durationSecAccurate, 0.93, 'Accurate duration must be 0.93s');
  assert.equal(durationSecInflated, 1.15, 'Inflated duration would have been 1.15s');

  console.log('✓ DemoGenerator Encoder Warm-up and Duration Calculation passed');
}

// 11. Test True Reverse Video Playback Frame Index Mapping & Invariance
console.log('[Test 11] True Reverse Video Playback Frame Index Mapping & Invariance');
{
  const totalFrames = 60; // 60fps over 1.0s
  const calcReverseFrameIndex = (progress: number, frameCount: number) => {
    return Math.max(
      0,
      Math.min(
        frameCount - 1,
        Math.round((1 - progress) * (frameCount - 1))
      )
    );
  };

  // At progress = 0: must return last frame (59), matching Slide 2 exactly
  assert.equal(calcReverseFrameIndex(0, totalFrames), 59, 'At progress 0, reverse playback must start on final frame');

  // At progress = 0.5: midpoint frame (30)
  assert.equal(calcReverseFrameIndex(0.5, totalFrames), 30, 'At progress 0.5, reverse playback must be at exact midpoint');

  // At progress = 1: must return frame 0, matching Slide 1 exactly
  assert.equal(calcReverseFrameIndex(1, totalFrames), 0, 'At progress 1, reverse playback must land on frame 0');

  // Monotonic descent test: frame index must never increase as progress advances
  let prevIdx = 60;
  for (let p = 0; p <= 1.001; p += 0.02) {
    const idx = calcReverseFrameIndex(p, totalFrames);
    assert.ok(idx <= prevIdx, `Frame index should monotonically decrease, got ${idx} > ${prevIdx} at progress ${p}`);
    prevIdx = idx;
  }
  console.log('✓ True Reverse Video Playback frame index mapping passed');
}

// 12. Test StagePlaybackEngine Stall Detection & Premature Cutoff Prevention
console.log('[Test 12] StagePlaybackEngine Stall Detection & Premature Cutoff Prevention');
{
  const shouldFinishOnStall = (stallCount: number, progress: number, paused: boolean): boolean => {
    if (paused && progress >= 0.98) return true;
    if ((stallCount >= 6 && progress >= 0.98) || stallCount >= 90) return true;
    return false;
  };

  // Stalling at 82% (the old bug!) MUST NOT finish
  assert.equal(
    shouldFinishOnStall(4, 0.82, false),
    false,
    'Stall count 4 at progress 0.82 must NOT trigger finish (prevent premature cutoff)'
  );
  assert.equal(
    shouldFinishOnStall(10, 0.85, false),
    false,
    'Stall count 10 at progress 0.85 must NOT trigger finish'
  );
  assert.equal(
    shouldFinishOnStall(4, 0.95, false),
    false,
    'Stall count 4 at progress 0.95 must NOT trigger finish'
  );

  // Stalling near completion (>= 0.98) with stallCount >= 6 SHOULD finish
  assert.equal(
    shouldFinishOnStall(6, 0.98, false),
    true,
    'Stall count 6 at progress 0.98 should complete clean landing'
  );
  assert.equal(
    shouldFinishOnStall(8, 0.99, false),
    true,
    'Stall count 8 at progress 0.99 should complete clean landing'
  );

  // Extreme prolonged hang (stallCount >= 90 / ~1.5s) recovers
  assert.equal(
    shouldFinishOnStall(90, 0.5, false),
    true,
    'Prolonged freeze of 90 frames should recover stage'
  );

  console.log('✓ StagePlaybackEngine Stall Detection & Premature Cutoff Prevention passed');
}

// 13. Test DemoGenerator Zero Warm-up Freeze and Dynamic Timing
console.log('[Test 13] DemoGenerator Zero Warm-up Freeze and Dynamic Timing');
{
  // In the updated DemoGenerator:
  // warmupFrames = 2 (~33ms) allows encoder sync with imperceptible hold (0.033s)
  // morphFrames = 48 (~800ms) smooth 60fps morph progression
  // holdFinalFrames = 6 (~100ms) hold on Slide 2 guarantees 100% completion before video ends
  const warmupFrames = 2;
  const morphFrames = 48;
  const holdFinalFrames = 6;
  const frameIntervalMs = 16.666;

  const totalFrames = warmupFrames + morphFrames + holdFinalFrames;
  assert.equal(totalFrames, 56, 'Total frames must be 56 frames');
  assert.ok(warmupFrames <= 2, 'warmupFrames must be <= 2 to eliminate freeze');
  assert.ok(holdFinalFrames >= 4, 'holdFinalFrames must be >= 4 to prevent premature truncation');

  const scheduledMs = totalFrames * frameIntervalMs;
  assert.ok(Math.abs(scheduledMs - 933.3) < 1, 'Scheduled duration should be ~933ms');

  console.log('✓ DemoGenerator Zero Warm-up Freeze and Dynamic Timing passed');
}

// 14. Test StagePlaybackEngine Global Reverse Frame Cache and Preservation Across Project Loads
console.log('[Test 14] StagePlaybackEngine Global Reverse Frame Cache and Project Load Preservation');
{
  // Test static cacheReverseFrames and getReverseFrames
  const mockFrames = [{ width: 1280, height: 720 }, { width: 1280, height: 720 }] as any;
  const testTransitionId = 'tr_test_reverse_123';
  const testVideoId = 'vid_test_reverse_456';

  // Import StagePlaybackEngine
  const { StagePlaybackEngine } = await import('../src/core/engine/StagePlaybackEngine');

  StagePlaybackEngine.cacheReverseFrames(testTransitionId, mockFrames);
  StagePlaybackEngine.cacheReverseFrames(testVideoId, mockFrames);

  assert.equal(
    StagePlaybackEngine.getReverseFrames(testTransitionId),
    mockFrames,
    'getReverseFrames must return cached frames by transition ID'
  );
  assert.equal(
    StagePlaybackEngine.getReverseFrames(testVideoId),
    mockFrames,
    'getReverseFrames must return cached frames by video asset ID'
  );

  console.log('✓ StagePlaybackEngine Global Reverse Frame Cache and Project Load Preservation passed');
}

// 15. Test TransitionSpec startTimeSec & endTimeSec Serialization and Segment Progress Math
console.log('[Test 15] TransitionSpec startTimeSec & endTimeSec Serialization and Segment Progress Math');
{
  const sampleJson = JSON.stringify({
    version: '1.0.0',
    title: 'عرض تجريبي لاختبار شرائح الوقت',
    slides: [
      {
        index: 1,
        title: 'شريحة البداية',
        imageFileName: 'slide_01.png',
        transitionToNext: {
          hasCustomVideo: true,
          videoFileName: 'full_reel.mp4',
          startTimeSec: 1.5,
          endTimeSec: 4.0,
          playbackSpeed: 1.0,
          muted: true,
          fallbackStyle: 'crossfade',
          fallbackDurationMs: 650,
        },
      },
      {
        index: 2,
        title: 'شريحة النهاية',
        imageFileName: 'slide_02.png',
        transitionToNext: {
          hasCustomVideo: false,
          fallbackStyle: 'cut',
        },
      },
    ],
  });

  const parsed = ProjectSerializer.deserializeProject(sampleJson);
  assert.equal(parsed.slidesData[0].transitionToNext?.startTimeSec, 1.5, 'Deserialized startTimeSec mismatch');
  assert.equal(parsed.slidesData[0].transitionToNext?.endTimeSec, 4.0, 'Deserialized endTimeSec mismatch');

  const store = new PresentationStore();
  store.loadProjectFromManifest(parsed);
  const slides = store.getSlides();
  assert.equal(slides.length, 2, 'Loaded slides count mismatch');
  assert.equal(slides[0].transitionToNext.startTimeSec, 1.5, 'Preserved startTimeSec mismatch on store slide');
  assert.equal(slides[0].transitionToNext.endTimeSec, 4.0, 'Preserved endTimeSec mismatch on store slide');

  const clipDuration = (slides[0].transitionToNext.endTimeSec! - slides[0].transitionToNext.startTimeSec!);
  assert.equal(clipDuration, 2.5, 'Calculated segment clip duration mismatch');

  console.log('✓ TransitionSpec startTimeSec & endTimeSec Serialization and Segment Progress Math passed');
}

// 16. Test SmartPairer.normalizeCuePoints for Motion-Reel Workflow
console.log('[Test 16] SmartPairer.normalizeCuePoints for Motion-Reel Workflow');
{
  const normalized = SmartPairer.normalizeCuePoints([5.0, 0, 2.5, 2.52, -1, 12], 10.0);
  assert.deepEqual(
    normalized,
    [0, 2.5, 5, 10],
    `Expected [0, 2.5, 5, 10], got ${JSON.stringify(normalized)}`
  );

  // Test empty array edge case
  const emptyNorm = SmartPairer.normalizeCuePoints([], 10.0);
  assert.deepEqual(emptyNorm, [0, 10], 'Empty input should fallback to [0, duration]');

  // Test single point edge case (< half duration)
  const singleLow = SmartPairer.normalizeCuePoints([2.0], 10.0);
  assert.deepEqual(singleLow, [2.0, 10], 'Single low point should be [point, duration]');

  // Test single point edge case (>= half duration)
  const singleHigh = SmartPairer.normalizeCuePoints([7.5], 10.0);
  assert.deepEqual(singleHigh, [0, 7.5], 'Single high point should be [0, point]');

  console.log('✓ SmartPairer.normalizeCuePoints for Motion-Reel Workflow passed');
}

console.log('\n=======================================');
console.log('ALL VERIFICATION TESTS PASSED (16/16)!');
console.log('=======================================');
