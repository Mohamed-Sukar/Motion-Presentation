import {
  EngineStatus,
  FallbackTransitionStyle,
  PresentationSettings,
  SlideNode,
  TransitionSpec,
} from '../domain/types';

export type EngineStatusListener = (status: EngineStatus) => void;

export class StagePlaybackEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private slides: SlideNode[] = [];
  private settings: PresentationSettings;

  private imageCache = new Map<string, HTMLImageElement>();
  private videoCache = new Map<string, HTMLVideoElement>();
  private reverseFrameCache = new Map<string, (ImageBitmap | HTMLCanvasElement)[]>();
  private static globalReverseFrameCache = new Map<string, (ImageBitmap | HTMLCanvasElement)[]>();

  static cacheReverseFrames(
    key: string,
    frames: (ImageBitmap | HTMLCanvasElement)[]
  ): void {
    StagePlaybackEngine.globalReverseFrameCache.set(key, frames);
  }

  static getReverseFrames(
    key: string
  ): (ImageBitmap | HTMLCanvasElement)[] | undefined {
    return StagePlaybackEngine.globalReverseFrameCache.get(key);
  }

  static clearGlobalReverseFrameCache(): void {
    for (const [, frames] of StagePlaybackEngine.globalReverseFrameCache.entries()) {
      for (const f of frames) {
        if ('close' in f && typeof f.close === 'function') {
          f.close();
        } else if (f instanceof HTMLCanvasElement) {
          f.width = 0;
          f.height = 0;
        }
      }
    }
    StagePlaybackEngine.globalReverseFrameCache.clear();
  }

  private status: EngineStatus = {
    phase: 'IDLE',
    currentSlideIndex: 0,
    targetSlideIndex: null,
    transitionProgress: 0,
    preloadProgress: 0,
    activeTransitionHasVideo: false,
    isFastForwarding: false,
    errorMessage: null,
  };

  private listeners = new Set<EngineStatusListener>();
  private rafId: number | null = null;
  private activeVideo: HTMLVideoElement | null = null;
  private activeProceduralTransition: { speedUp: () => void } | null = null;
  private holdTimerId: number | null = null;
  private preBlackoutPhase: 'HOLDING_SLIDE' | 'IDLE' = 'HOLDING_SLIDE';
  private isTransitionReverse = false;

  constructor(canvas: HTMLCanvasElement, initialSettings: PresentationSettings) {
    this.canvas = canvas;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) {
      throw new Error('تعذر تهيئة محرك الرسم ثنائي الأبعاد (Canvas 2D)');
    }
    this.ctx = context;
    this.settings = initialSettings;
    this.syncCanvasResolution();
  }

  onStatusChange(listener: EngineStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  getStatus(): EngineStatus {
    return { ...this.status };
  }

  private emitStatus(patch?: Partial<EngineStatus>): void {
    if (patch) {
      this.status = { ...this.status, ...patch };
    }
    const snapshot = this.getStatus();
    for (const l of this.listeners) {
      l(snapshot);
    }
  }

  syncCanvasResolution(): void {
    const ratioMap: Record<PresentationSettings['aspectRatio'], [number, number]> = {
      '16:9': [1920, 1080],
      '16:10': [1920, 1200],
      '4:3': [1600, 1200],
      '9:16': [1080, 1920],
    };
    const [w, h] = ratioMap[this.settings.aspectRatio] || [1920, 1080];
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
  }

  async loadProject(
    slides: SlideNode[],
    settings: PresentationSettings,
    startIndex = 0
  ): Promise<void> {
    this.stopCurrentAnimation();
    this.slides = slides;
    this.settings = settings;
    this.syncCanvasResolution();
    this.cleanUnusedReverseFrameCache();

    if (slides.length === 0) {
      this.clearStage();
      this.emitStatus({
        phase: 'IDLE',
        currentSlideIndex: 0,
        targetSlideIndex: null,
        transitionProgress: 0,
        preloadProgress: 0,
        activeTransitionHasVideo: false,
        isFastForwarding: false,
      });
      return;
    }

    const clampedStart = Math.max(0, Math.min(startIndex, slides.length - 1));
    this.emitStatus({
      phase: 'PRELOADING',
      currentSlideIndex: clampedStart,
      targetSlideIndex: null,
      preloadProgress: 0,
      errorMessage: null,
    });

    if (this.settings.preloadStrategy === 'adjacent') {
      const indicesToWarm = new Set<number>();
      indicesToWarm.add(clampedStart);
      if (clampedStart + 1 < slides.length) {
        indicesToWarm.add(clampedStart + 1);
      } else if (this.settings.loopPresentation && slides.length > 1) {
        indicesToWarm.add(0);
      }
      if (clampedStart - 1 >= 0) {
        indicesToWarm.add(clampedStart - 1);
      } else if (this.settings.loopPresentation && slides.length > 1) {
        indicesToWarm.add(slides.length - 1);
      }

      let loadedCount = 0;
      const totalToWarm = indicesToWarm.size * 2;
      for (const idx of indicesToWarm) {
        const slide = slides[idx];
        if (slide) {
          await this.ensureImageLoaded(slide.imageAsset.id, slide.imageAsset.objectUrl);
          loadedCount++;
          this.emitStatus({
            preloadProgress: Math.min(1, loadedCount / Math.max(1, totalToWarm)),
          });
          if (slide.transitionToNext.videoAsset) {
            await this.ensureVideoWarmed(
              slide.transitionToNext.videoAsset.id,
              slide.transitionToNext.videoAsset.objectUrl
            );
            loadedCount++;
            this.emitStatus({
              preloadProgress: Math.min(1, loadedCount / Math.max(1, totalToWarm)),
            });
          }
        }
      }
    } else {
      const totalAssets =
        slides.length +
        slides.filter((s) => Boolean(s.transitionToNext.videoAsset)).length;
      let loadedCount = 0;

      const bumpProgress = () => {
        loadedCount++;
        this.emitStatus({
          preloadProgress: Math.min(1, loadedCount / Math.max(1, totalAssets)),
        });
      };

      // Preload all slide images & transition videos
      await Promise.all(
        slides.map(async (slide) => {
          await this.ensureImageLoaded(slide.imageAsset.id, slide.imageAsset.objectUrl);
          bumpProgress();

          if (slide.transitionToNext.videoAsset) {
            await this.ensureVideoWarmed(
              slide.transitionToNext.videoAsset.id,
              slide.transitionToNext.videoAsset.objectUrl
            );
            bumpProgress();
          }
        })
      );
    }

    this.enterHoldSlide(clampedStart);
  }

  updateSettingsLive(settings: PresentationSettings): void {
    this.settings = settings;
    this.syncCanvasResolution();
    if (this.activeVideo) {
      const currentSlide = this.slides[this.status.currentSlideIndex];
      const slideMuted = Boolean(currentSlide?.transitionToNext?.muted);
      this.activeVideo.muted = Boolean(settings.masterMuted || slideMuted);
      const masterVol =
        typeof settings.masterVolume === 'number' && !Number.isNaN(settings.masterVolume)
          ? settings.masterVolume
          : 0.9;
      this.activeVideo.volume = Math.max(0, Math.min(1, masterVol));
    }
    if (this.status.phase === 'HOLDING_SLIDE') {
      this.drawSlideByIndex(this.status.currentSlideIndex);
    }
  }

  pause(): void {
    this.stopCurrentAnimation();
  }

  /**
   * Primary Presenter Action: Advance to next slide (plays transition video if available)
   */
  next(): void {
    if (this.slides.length === 0) return;

    if (this.status.phase === 'BLACKOUT') {
      this.toggleBlackout();
      return;
    }

    // Handle click while transition is already playing
    if (this.status.phase === 'PLAYING_TRANSITION') {
      const behavior = this.settings.interruptBehavior;
      if (behavior === 'lock') {
        return; // Ignore input until transition finishes
      }
      if (behavior === 'skip') {
        if (this.isTransitionReverse) {
          // Mid-backward transition: pressing next reverses direction and returns forward to start slide
          this.completeTransitionImmediately(this.status.currentSlideIndex);
        } else if (this.status.targetSlideIndex !== null) {
          // Mid-forward transition: complete directly to target slide
          this.completeTransitionImmediately(this.status.targetSlideIndex);
        }
        return;
      }
      if (behavior === 'fast-forward') {
        if (this.activeVideo) {
          this.activeVideo.playbackRate = Math.min(
            8.0,
            this.activeVideo.playbackRate * 3.0
          );
          this.emitStatus({ isFastForwarding: true });
          return;
        } else if (this.activeProceduralTransition) {
          this.activeProceduralTransition.speedUp();
          this.emitStatus({ isFastForwarding: true });
          return;
        }
      }
      return;
    }

    const currentIdx = this.status.currentSlideIndex;
    let nextIdx = currentIdx + 1;

    if (nextIdx >= this.slides.length) {
      if (this.settings.loopPresentation && this.slides.length > 1) {
        nextIdx = 0;
      } else {
        // Already at final slide
        return;
      }
    }

    this.startForwardTransition(currentIdx, nextIdx);
  }

  /**
   * Presenter Action: Go back to previous slide
   */
  previous(): void {
    if (this.slides.length === 0) return;

    if (this.status.phase === 'BLACKOUT') {
      this.toggleBlackout();
      return;
    }

    // If currently mid-transition:
    if (this.status.phase === 'PLAYING_TRANSITION') {
      if (this.isTransitionReverse && this.status.targetSlideIndex !== null) {
        // Already moving backward: complete backward motion to destination slide
        this.completeTransitionImmediately(this.status.targetSlideIndex);
      } else {
        // Moving forward: cancel forward motion and return cleanly to starting slide
        this.completeTransitionImmediately(this.status.currentSlideIndex);
      }
      return;
    }

    const currentIdx = this.status.currentSlideIndex;
    let prevIdx = currentIdx - 1;
    if (prevIdx < 0) {
      if (this.settings.loopPresentation && this.slides.length > 1) {
        prevIdx = this.slides.length - 1;
      } else {
        return;
      }
    }

    if (this.settings.backwardBehavior === 'instant') {
      this.enterHoldSlide(prevIdx);
      return;
    }

    if (this.settings.backwardBehavior === 'crossfade') {
      const dur = this.settings.defaultFallbackDurationMs || 420;
      this.runProceduralTransition(currentIdx, prevIdx, 'crossfade', dur, true);
      return;
    }

    // Default / 'reverse-step': cleanly mirror the forward transition of the source slide
    const prevSlide = this.slides[prevIdx];
    const spec = prevSlide?.transitionToNext;

    // TRUE REVERSE VIDEO PLAYBACK:
    // If the transition between prevIdx and currentIdx has a video transition,
    // play the cached video frames in true reverse!
    if (spec?.videoAsset) {
      const isSegment =
        typeof spec.startTimeSec === 'number' || typeof spec.endTimeSec === 'number';
      const cachedFrames = isSegment
        ? this.getReverseFrames(spec.id)
        : (this.getReverseFrames(spec.id) || this.getReverseFrames(spec.videoAsset.id));
      if (cachedFrames && cachedFrames.length > 0) {
        this.runReverseVideoTransition(currentIdx, prevIdx, spec, cachedFrames);
        return;
      }
    }

    const style: FallbackTransitionStyle =
      spec?.fallbackStyle && spec.fallbackStyle !== 'crossfade'
        ? spec.fallbackStyle
        : (this.settings.defaultFallbackStyle && this.settings.defaultFallbackStyle !== 'crossfade')
          ? this.settings.defaultFallbackStyle
          : 'zoom-morph';
    const durationMs =
      spec?.fallbackDurationMs || this.settings.defaultFallbackDurationMs || 500;

    this.runProceduralTransition(currentIdx, prevIdx, style, durationMs, true);
  }

  /**
   * Jump directly to any slide index (used by timeline selection or Grid Jump 'G')
   */
  jumpToSlide(index: number, withCrossfade = false): void {
    if (this.slides.length === 0) return;
    const target = Math.max(0, Math.min(index, this.slides.length - 1));
    if (withCrossfade && target !== this.status.currentSlideIndex) {
      this.stopCurrentAnimation();
      this.runProceduralTransition(
        this.status.currentSlideIndex,
        target,
        'crossfade',
        350,
        target < this.status.currentSlideIndex
      );
    } else {
      this.enterHoldSlide(target);
    }
  }

  /**
   * Replay the transition from the current slide to the next slide (great for previewing in Studio!)
   */
  previewCurrentTransition(): void {
    if (this.slides.length === 0) return;
    const currentIdx = this.status.currentSlideIndex;
    const nextIdx =
      currentIdx + 1 < this.slides.length
        ? currentIdx + 1
        : this.settings.loopPresentation && this.slides.length > 1
          ? 0
          : -1;

    if (nextIdx === -1) return;
    this.enterHoldSlide(currentIdx);
    this.startForwardTransition(currentIdx, nextIdx);
  }

  toggleBlackout(): void {
    if (this.status.phase === 'BLACKOUT') {
      this.enterHoldSlide(this.status.currentSlideIndex);
    } else {
      this.stopCurrentAnimation();
      this.preBlackoutPhase = 'HOLDING_SLIDE';
      this.ctx.fillStyle = '#000000';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.emitStatus({
        phase: 'BLACKOUT',
        transitionProgress: 0,
      });
    }
  }

  destroy(): void {
    this.stopCurrentAnimation();
    this.videoCache.forEach((v) => {
      v.pause();
      v.removeAttribute('src');
      v.load();
    });
    this.videoCache.clear();
    this.imageCache.clear();
    this.clearReverseFrameCache();
    this.listeners.clear();
  }

  private enterHoldSlide(slideIndex: number): void {
    this.stopCurrentAnimation();
    this.isTransitionReverse = false;
    const clamped = Math.max(0, Math.min(slideIndex, this.slides.length - 1));
    this.drawSlideByIndex(clamped);

    this.emitStatus({
      phase: 'HOLDING_SLIDE',
      currentSlideIndex: clamped,
      targetSlideIndex: null,
      transitionProgress: 0,
      activeTransitionHasVideo: false,
      isFastForwarding: false,
    });

    if (this.settings.preloadStrategy === 'adjacent') {
      this.maintainAdjacentCache(clamped);
    }

    // Check if slide has automatic hold timer
    const slide = this.slides[clamped];
    if (slide && slide.holdDurationSec && slide.holdDurationSec > 0) {
      this.holdTimerId = window.setTimeout(() => {
        if (
          this.status.phase === 'HOLDING_SLIDE' &&
          this.status.currentSlideIndex === clamped
        ) {
          this.next();
        }
      }, slide.holdDurationSec * 1000);
    }
  }

  private maintainAdjacentCache(currentIdx: number): void {
    if (this.slides.length === 0) return;

    const neededSlideIndices = new Set<number>();
    neededSlideIndices.add(currentIdx);
    if (currentIdx + 1 < this.slides.length) {
      neededSlideIndices.add(currentIdx + 1);
    } else if (this.settings.loopPresentation && this.slides.length > 1) {
      neededSlideIndices.add(0);
    }
    if (currentIdx - 1 >= 0) {
      neededSlideIndices.add(currentIdx - 1);
    } else if (this.settings.loopPresentation && this.slides.length > 1) {
      neededSlideIndices.add(this.slides.length - 1);
    }

    const neededVideoAssetIds = new Set<string>();
    const neededTransitionSpecIds = new Set<string>();
    for (const idx of neededSlideIndices) {
      const s = this.slides[idx];
      if (s?.transitionToNext?.videoAsset) {
        neededVideoAssetIds.add(s.transitionToNext.videoAsset.id);
        neededTransitionSpecIds.add(s.transitionToNext.id);
      }
    }

    // Evict unused video elements to prevent hardware decoder exhaustion
    for (const [vidId, videoEl] of this.videoCache.entries()) {
      if (!neededVideoAssetIds.has(vidId) && this.activeVideo !== videoEl) {
        videoEl.pause();
        videoEl.removeAttribute('src');
        videoEl.load();
        this.videoCache.delete(vidId);
      }
    }

    // Evict reverse frame caches only if cache has grown excessively large (> 16 transitions)
    if (this.reverseFrameCache.size > 16) {
      for (const [key, frames] of this.reverseFrameCache.entries()) {
        if (!neededTransitionSpecIds.has(key) && !neededVideoAssetIds.has(key)) {
          for (const f of frames) {
            if ('close' in f && typeof f.close === 'function') {
              f.close();
            } else if (f instanceof HTMLCanvasElement) {
              f.width = 0;
              f.height = 0;
            }
          }
          this.reverseFrameCache.delete(key);
        }
      }
    }

    // Asynchronously warm adjacent slides
    for (const idx of neededSlideIndices) {
      const s = this.slides[idx];
      if (s) {
        this.ensureImageLoaded(s.imageAsset.id, s.imageAsset.objectUrl).catch(() => {});
        if (s.transitionToNext.videoAsset) {
          this.ensureVideoWarmed(
            s.transitionToNext.videoAsset.id,
            s.transitionToNext.videoAsset.objectUrl
          ).then(() => {
            if (s.transitionToNext.videoAsset && !this.hasReverseFrames(s.transitionToNext.id)) {
              this.prewarmReverseFrames(s.transitionToNext.id, s.transitionToNext.videoAsset).catch(() => {});
            }
          }).catch(() => {});
        }
      }
    }
  }

  private startForwardTransition(fromIndex: number, toIndex: number): void {
    this.stopCurrentAnimation();
    this.isTransitionReverse = false;
    const fromSlide = this.slides[fromIndex];
    if (!fromSlide) return;

    const spec = fromSlide.transitionToNext;
    const videoAsset = spec.videoAsset;

    if (videoAsset) {
      this.runVideoTransition(fromIndex, toIndex, videoAsset.id, videoAsset.objectUrl);
    } else {
      this.runProceduralTransition(
        fromIndex,
        toIndex,
        spec.fallbackStyle || this.settings.defaultFallbackStyle,
        spec.fallbackDurationMs || this.settings.defaultFallbackDurationMs,
        false
      );
    }
  }

  private async runVideoTransition(
    fromIndex: number,
    toIndex: number,
    videoAssetId: string,
    videoObjectUrl: string
  ): Promise<void> {
    const fromSlide = this.slides[fromIndex];
    const spec = fromSlide.transitionToNext;

    // Time-slice / cue-point segment support: a single continuous video can play
    // a [startTimeSec, endTimeSec] sub-range between slides without flicker.
    const startTime =
      typeof spec.startTimeSec === 'number' && spec.startTimeSec >= 0
        ? spec.startTimeSec
        : 0;

    const video = await this.ensureVideoWarmed(videoAssetId, videoObjectUrl);
    this.activeVideo = video;

    const effectiveSpeed = Math.max(
      0.25,
      Math.min(4.0, this.settings.globalPlaybackSpeed * (spec.playbackSpeed || 1.0))
    );

    video.playbackRate = effectiveSpeed;
    video.muted = Boolean(this.settings.masterMuted || spec.muted);
    const masterVol =
      typeof this.settings.masterVolume === 'number' && !Number.isNaN(this.settings.masterVolume)
        ? this.settings.masterVolume
        : 0.9;
    video.volume = Math.max(0, Math.min(1, masterVol));
    video.currentTime = startTime;

    const recordedFrames: (ImageBitmap | HTMLCanvasElement)[] = [];
    let lastRecordedTime = -1;

    // Capture starting frame (Slide 1) as frame 0 of the recorded frames
    if (fromSlide) {
      const fromImg = this.imageCache.get(fromSlide.imageAsset.id);
      if (fromImg && fromImg.complete && fromImg.naturalWidth > 0) {
        const s1Canvas = document.createElement('canvas');
        s1Canvas.width = this.canvas.width;
        s1Canvas.height = this.canvas.height;
        const s1Ctx = s1Canvas.getContext('2d');
        if (s1Ctx) {
          this.drawMediaElement(fromImg, fromImg.naturalWidth, fromImg.naturalHeight);
          s1Ctx.drawImage(this.canvas, 0, 0);
          recordedFrames.push(s1Canvas);
        }
      }
    }

    this.emitStatus({
      phase: 'PLAYING_TRANSITION',
      currentSlideIndex: fromIndex,
      targetSlideIndex: toIndex,
      transitionProgress: 0,
      activeTransitionHasVideo: true,
      isFastForwarding: false,
    });

    let completed = false;
    const finish = async () => {
      if (completed) return;
      completed = true;

      // ZERO-FLICKER / CONTINUITY GUARD: Ensure destination slide image is fully ready
      // before clearing stage, so the last decoded video frame stays stably displayed.
      const toSlide = this.slides[toIndex];
      if (toSlide) {
        const cachedImg = this.imageCache.get(toSlide.imageAsset.id);
        if (!cachedImg || !cachedImg.complete) {
          try {
            await this.ensureImageLoaded(toSlide.imageAsset.id, toSlide.imageAsset.objectUrl);
          } catch {
            // Proceed to transition completion even if image load failed
          }
        }
        // Capture landing frame (Slide 2) as final frame in recordedFrames
        const readyImg = this.imageCache.get(toSlide.imageAsset.id);
        if (readyImg && readyImg.complete && readyImg.naturalWidth > 0) {
          const s2Canvas = document.createElement('canvas');
          s2Canvas.width = this.canvas.width;
          s2Canvas.height = this.canvas.height;
          const s2Ctx = s2Canvas.getContext('2d');
          if (s2Ctx) {
            this.clearStage();
            this.drawMediaElement(readyImg, readyImg.naturalWidth, readyImg.naturalHeight);
            s2Ctx.drawImage(this.canvas, 0, 0);
            recordedFrames.push(s2Canvas);
          }
        }
      }

      // Store recorded frames into reverse frame cache for true reverse playback.
      // Segment transitions (cue-point) only cache under the transition spec id so
      // multiple cues sharing one reel video asset don't overwrite each other's frames.
      if (recordedFrames.length > 0) {
        this.storeReverseFrames(spec.id, recordedFrames);
        if (typeof spec.startTimeSec === 'undefined' && typeof spec.endTimeSec === 'undefined') {
          if (spec.videoAsset?.id) {
            this.storeReverseFrames(spec.videoAsset.id, recordedFrames);
          }
        }
      }

      this.completeTransitionImmediately(toIndex);
    };

    video.onended = finish;
    video.onerror = () => {
      if (completed) return;
      completed = true;
      if (this.activeVideo === video) {
        video.onended = null;
        video.onerror = null;
        this.activeVideo = null;
      }
      this.runProceduralTransition(
        fromIndex,
        toIndex,
        spec.fallbackStyle || 'crossfade',
        spec.fallbackDurationMs || 650,
        false
      );
    };

    let lastVideoTime = -1;
    let stallCount = 0;

    const renderTick = () => {
      if (completed || this.activeVideo !== video) return;

      const fullDuration =
        Number.isFinite(video.duration) && video.duration > 0
          ? video.duration
          : spec.videoAsset?.durationSec && spec.videoAsset.durationSec > 0
            ? spec.videoAsset.durationSec
            : 1;
      const endTime =
        typeof spec.endTimeSec === 'number' && spec.endTimeSec > startTime
          ? Math.min(fullDuration, spec.endTimeSec)
          : fullDuration;
      const segmentDuration = Math.max(0.05, endTime - startTime);
      const progress = Math.min(1, Math.max(0, (video.currentTime - startTime) / segmentDuration));

      // ZERO-FLICKER / CONTINUITY GUARD: keep painting video only once decoded & past the start frame
      if (video.readyState >= 2 && video.currentTime > startTime + 0.001) {
        this.clearStage();
        this.drawMediaElement(video, video.videoWidth || 1920, video.videoHeight || 1080);

        // Record decoded frame synchronously into cache for true reverse playback
        if (Math.abs(video.currentTime - lastRecordedTime) >= 0.012) {
          lastRecordedTime = video.currentTime;
          const frameCanvas = document.createElement('canvas');
          frameCanvas.width = this.canvas.width;
          frameCanvas.height = this.canvas.height;
          const fCtx = frameCanvas.getContext('2d');
          if (fCtx) {
            fCtx.drawImage(this.canvas, 0, 0);
            recordedFrames.push(frameCanvas);
          }
        }
      } else {
        this.drawSlideByIndex(fromIndex);
      }

      this.emitStatus({ transitionProgress: progress });

      // Segment completion detection handles normal end, trimmed end, and WebM Infinity durations
      if (video.ended || (segmentDuration > 0.05 && video.currentTime >= endTime - 0.015)) {
        video.pause();
        finish();
        return;
      }

      // If the browser paused or stalled on decoded final frames without firing ended
      if (video.currentTime > 0.2) {
        if (video.paused && progress >= 0.98) {
          finish();
          return;
        }
        if (Math.abs(video.currentTime - lastVideoTime) < 0.0001) {
          stallCount++;
          // Never truncate at 0.82! Only finish if genuinely stalled at the very end (progress >= 0.98)
          // or hung for a prolonged period (>= 90 frames / ~1.5s)
          if ((stallCount >= 6 && progress >= 0.98) || stallCount >= 90) {
            finish();
            return;
          }
        } else {
          stallCount = 0;
          lastVideoTime = video.currentTime;
        }
      }

      this.rafId = requestAnimationFrame(renderTick);
    };

    try {
      await video.play();
      this.rafId = requestAnimationFrame(renderTick);
    } catch {
      if (this.activeVideo === video) {
        video.onended = null;
        video.onerror = null;
        this.activeVideo = null;
      }
      // Fallback to procedural transition if video playback fails for any reason
      this.runProceduralTransition(
        fromIndex,
        toIndex,
        spec.fallbackStyle || 'crossfade',
        spec.fallbackDurationMs || 650,
        false
      );
    }
  }

  private runProceduralTransition(
    fromIndex: number,
    toIndex: number,
    style: FallbackTransitionStyle,
    durationMs: number,
    isReverse = false
  ): void {
    this.isTransitionReverse = isReverse;
    if (style === 'cut' || durationMs <= 16) {
      this.enterHoldSlide(toIndex);
      return;
    }

    const fromSlide = this.slides[fromIndex];
    const toSlide = this.slides[toIndex];
    if (!fromSlide || !toSlide) {
      this.enterHoldSlide(toIndex);
      return;
    }

    const fromImg = this.imageCache.get(fromSlide.imageAsset.id);
    const toImg = this.imageCache.get(toSlide.imageAsset.id);
    if (!fromImg || !toImg) {
      this.enterHoldSlide(toIndex);
      return;
    }

    let speedMultiplier = Math.max(0.25, this.settings.globalPlaybackSpeed);
    this.activeProceduralTransition = {
      speedUp: () => {
        speedMultiplier = Math.min(8.0, speedMultiplier * 3.0);
      },
    };

    let lastTime = performance.now();
    let elapsedProgress = 0;
    const baseDuration = Math.max(80, durationMs);

    this.emitStatus({
      phase: 'PLAYING_TRANSITION',
      currentSlideIndex: fromIndex,
      targetSlideIndex: toIndex,
      transitionProgress: 0,
      activeTransitionHasVideo: false,
      isFastForwarding: false,
    });

    const step = (now: number) => {
      const dt = now - lastTime;
      lastTime = now;
      elapsedProgress += (dt * speedMultiplier) / baseDuration;
      const rawProgress = Math.min(1, elapsedProgress);
      const t = this.easeInOutCubic(rawProgress);

      this.clearStage();
      const w = this.canvas.width;
      const h = this.canvas.height;

      if (style === 'crossfade') {
        this.ctx.save();
        this.ctx.globalAlpha = 1;
        this.drawMediaElement(fromImg, fromImg.naturalWidth, fromImg.naturalHeight);
        this.ctx.globalAlpha = t;
        this.drawMediaElement(toImg, toImg.naturalWidth, toImg.naturalHeight);
        this.ctx.restore();
      } else if (style === 'zoom-morph') {
        // True reverse cleanly mirrors the forward zoom-morph:
        // Forward: outgoing zooms 1.0 -> 1.14 (fades out), incoming zooms 0.88 -> 1.0 (fades in)
        // Reverse: outgoing zooms 1.0 -> 0.88 (fades out), incoming zooms 1.14 -> 1.0 (fades in)
        const outScale = isReverse ? 1 - t * 0.12 : 1 + t * 0.14;
        const inScale = isReverse ? 1.14 - t * 0.14 : 0.88 + t * 0.12;

        this.ctx.save();
        this.ctx.translate(w / 2, h / 2);
        this.ctx.scale(outScale, outScale);
        this.ctx.translate(-w / 2, -h / 2);
        this.ctx.globalAlpha = 1 - t;
        this.drawMediaElement(fromImg, fromImg.naturalWidth, fromImg.naturalHeight);
        this.ctx.restore();

        this.ctx.save();
        this.ctx.translate(w / 2, h / 2);
        this.ctx.scale(inScale, inScale);
        this.ctx.translate(-w / 2, -h / 2);
        this.ctx.globalAlpha = t;
        this.drawMediaElement(toImg, toImg.naturalWidth, toImg.naturalHeight);
        this.ctx.restore();
      } else if (style === 'slide-push') {
        const dir = isReverse ? 1 : -1;
        this.ctx.save();
        this.ctx.translate(dir * t * w, 0);
        this.drawMediaElement(fromImg, fromImg.naturalWidth, fromImg.naturalHeight);
        this.ctx.restore();

        this.ctx.save();
        this.ctx.translate(-dir * (1 - t) * w, 0);
        this.drawMediaElement(toImg, toImg.naturalWidth, toImg.naturalHeight);
        this.ctx.restore();
      }

      this.emitStatus({ transitionProgress: rawProgress });

      if (rawProgress < 1) {
        this.rafId = requestAnimationFrame(step);
      } else {
        this.activeProceduralTransition = null;
        this.completeTransitionImmediately(toIndex);
      }
    };

    this.rafId = requestAnimationFrame(step);
  }

  private completeTransitionImmediately(targetIndex: number): void {
    this.stopCurrentAnimation();
    this.enterHoldSlide(targetIndex);
  }

  private stopCurrentAnimation(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.holdTimerId !== null) {
      clearTimeout(this.holdTimerId);
      this.holdTimerId = null;
    }
    if (this.activeVideo) {
      this.activeVideo.onended = null;
      this.activeVideo.onerror = null;
      this.activeVideo.pause();
      this.activeVideo = null;
    }
    this.activeProceduralTransition = null;
  }

  private drawSlideByIndex(index: number): void {
    this.clearStage();
    const slide = this.slides[index];
    if (!slide) return;
    const img = this.imageCache.get(slide.imageAsset.id);
    if (img && img.complete && img.naturalWidth > 0) {
      this.drawMediaElement(
        img,
        img.naturalWidth || slide.imageAsset.width,
        img.naturalHeight || slide.imageAsset.height
      );
    } else {
      // If image is not yet loaded into cache, asynchronously load and paint upon arrival
      this.ensureImageLoaded(slide.imageAsset.id, slide.imageAsset.objectUrl).then((loaded) => {
        if (
          this.status.currentSlideIndex === index &&
          this.status.phase === 'HOLDING_SLIDE'
        ) {
          this.clearStage();
          this.drawMediaElement(
            loaded,
            loaded.naturalWidth || slide.imageAsset.width,
            loaded.naturalHeight || slide.imageAsset.height
          );
        }
      });
    }
  }

  private clearStage(): void {
    this.ctx.fillStyle = this.settings.stageBackground || '#05070B';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private drawMediaElement(
    element: HTMLImageElement | HTMLVideoElement | ImageBitmap | HTMLCanvasElement,
    sourceWidth: number,
    sourceHeight: number
  ): void {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const sw = sourceWidth || cw;
    const sh = sourceHeight || ch;

    const scale =
      this.settings.fitMode === 'cover'
        ? Math.max(cw / sw, ch / sh)
        : Math.min(cw / sw, ch / sh);

    const drawW = sw * scale;
    const drawH = sh * scale;
    const offsetX = (cw - drawW) / 2;
    const offsetY = (ch - drawH) / 2;

    this.ctx.drawImage(element as CanvasImageSource, offsetX, offsetY, drawW, drawH);
  }

  /**
   * TRUE REVERSE VIDEO TRANSITION:
   * Plays buffered canvas/video frames in true reverse from last frame down to frame 0
   * at 60fps matching the original transition duration.
   */
  private runReverseVideoTransition(
    fromIndex: number,
    toIndex: number,
    spec: TransitionSpec,
    frames: (ImageBitmap | HTMLCanvasElement)[]
  ): void {
    this.stopCurrentAnimation();
    this.isTransitionReverse = true;

    const fromSlide = this.slides[fromIndex];
    const toSlide = this.slides[toIndex];
    if (!fromSlide || !toSlide || frames.length === 0) {
      this.enterHoldSlide(toIndex);
      return;
    }

    const durationSec = typeof spec.startTimeSec === 'number' || typeof spec.endTimeSec === 'number'
      ? Math.max(0.1, (spec.endTimeSec ?? (spec.videoAsset?.durationSec || 1)) - (spec.startTimeSec ?? 0))
      : (spec.videoAsset?.durationSec && spec.videoAsset.durationSec > 0
        ? spec.videoAsset.durationSec
        : frames.length / 60);
    const baseDurationMs = Math.max(80, durationSec * 1000);

    let speedMultiplier = Math.max(
      0.25,
      Math.min(4.0, this.settings.globalPlaybackSpeed * (spec.playbackSpeed || 1.0))
    );

    this.activeProceduralTransition = {
      speedUp: () => {
        speedMultiplier = Math.min(8.0, speedMultiplier * 3.0);
      },
    };

    let lastTime = performance.now();
    let elapsedProgress = 0;

    this.emitStatus({
      phase: 'PLAYING_TRANSITION',
      currentSlideIndex: fromIndex,
      targetSlideIndex: toIndex,
      transitionProgress: 0,
      activeTransitionHasVideo: true,
      isFastForwarding: false,
    });

    let completed = false;
    const finish = async () => {
      if (completed) return;
      completed = true;
      this.activeProceduralTransition = null;

      // ZERO-FLICKER / CONTINUITY GUARD: Ensure destination slide image is fully ready
      const cachedImg = this.imageCache.get(toSlide.imageAsset.id);
      if (!cachedImg || !cachedImg.complete) {
        try {
          await this.ensureImageLoaded(toSlide.imageAsset.id, toSlide.imageAsset.objectUrl);
        } catch {
          // Proceed
        }
      }

      this.completeTransitionImmediately(toIndex);
    };

    const step = (now: number) => {
      if (completed) return;
      const dt = now - lastTime;
      lastTime = now;
      elapsedProgress += (dt * speedMultiplier) / baseDurationMs;
      const progress = Math.min(1, Math.max(0, elapsedProgress));

      // Reverse mapping: progress = 0 -> last frame (frames.length - 1)
      // progress = 1 -> first frame (0)
      const frameIdx = Math.max(
        0,
        Math.min(
          frames.length - 1,
          Math.round((1 - progress) * (frames.length - 1))
        )
      );

      const frame = frames[frameIdx];
      if (frame) {
        this.clearStage();
        const frameW = frame instanceof HTMLCanvasElement ? frame.width : frame.width;
        const frameH = frame instanceof HTMLCanvasElement ? frame.height : frame.height;
        this.drawMediaElement(frame, frameW, frameH);
      }

      this.emitStatus({ transitionProgress: progress });

      if (progress < 1) {
        this.rafId = requestAnimationFrame(step);
      } else {
        finish();
      }
    };

    this.rafId = requestAnimationFrame(step);
  }

  private async captureFrame(
    source: HTMLVideoElement | HTMLCanvasElement
  ): Promise<ImageBitmap | HTMLCanvasElement> {
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(source);
      } catch {
        // Fallback to canvas
      }
    }
    const offscreen = document.createElement('canvas');
    const w = source instanceof HTMLVideoElement ? (source.videoWidth || 1920) : source.width;
    const h = source instanceof HTMLVideoElement ? (source.videoHeight || 1080) : source.height;
    offscreen.width = w;
    offscreen.height = h;
    const offCtx = offscreen.getContext('2d');
    if (offCtx) {
      offCtx.drawImage(source, 0, 0, w, h);
    }
    return offscreen;
  }

  getReverseFrames(key: string): (ImageBitmap | HTMLCanvasElement)[] | undefined {
    return this.reverseFrameCache.get(key) || StagePlaybackEngine.globalReverseFrameCache.get(key);
  }

  hasReverseFrames(specId: string): boolean {
    const frames = this.getReverseFrames(specId);
    return Boolean(frames && frames.length > 0);
  }

  private storeReverseFrames(
    cacheKey: string,
    frames: (ImageBitmap | HTMLCanvasElement)[]
  ): void {
    const existing = this.reverseFrameCache.get(cacheKey);
    if (existing && existing !== frames) {
      for (const f of existing) {
        if ('close' in f && typeof f.close === 'function') {
          f.close();
        } else if (f instanceof HTMLCanvasElement) {
          f.width = 0;
          f.height = 0;
        }
      }
    }
    this.reverseFrameCache.set(cacheKey, frames);
    StagePlaybackEngine.globalReverseFrameCache.set(cacheKey, frames);
  }

  private cleanUnusedReverseFrameCache(): void {
    if (this.slides.length === 0) {
      this.clearReverseFrameCache();
      return;
    }
    const validKeys = new Set<string>();
    for (const s of this.slides) {
      validKeys.add(s.transitionToNext.id);
      if (s.transitionToNext.videoAsset) {
        validKeys.add(s.transitionToNext.videoAsset.id);
      }
    }

    for (const [key, frames] of this.reverseFrameCache.entries()) {
      if (!validKeys.has(key)) {
        for (const f of frames) {
          if ('close' in f && typeof f.close === 'function') {
            f.close();
          } else if (f instanceof HTMLCanvasElement) {
            f.width = 0;
            f.height = 0;
          }
        }
        this.reverseFrameCache.delete(key);
      }
    }

    for (const [key, frames] of StagePlaybackEngine.globalReverseFrameCache.entries()) {
      if (!validKeys.has(key)) {
        for (const f of frames) {
          if ('close' in f && typeof f.close === 'function') {
            f.close();
          } else if (f instanceof HTMLCanvasElement) {
            f.width = 0;
            f.height = 0;
          }
        }
        StagePlaybackEngine.globalReverseFrameCache.delete(key);
      }
    }
  }

  clearReverseFrameCache(): void {
    for (const [, frames] of this.reverseFrameCache.entries()) {
      for (const f of frames) {
        if ('close' in f && typeof f.close === 'function') {
          f.close();
        } else if (f instanceof HTMLCanvasElement) {
          f.width = 0;
          f.height = 0;
        }
      }
    }
    this.reverseFrameCache.clear();
  }

  private async prewarmReverseFrames(
    specId: string,
    videoAsset: { id: string; objectUrl: string; durationSec?: number },
    startTimeSec?: number,
    endTimeSec?: number
  ): Promise<void> {
    if (this.hasReverseFrames(specId) || this.hasReverseFrames(videoAsset.id)) return;
    if (typeof document === 'undefined') return;

    try {
      const start = startTimeSec ?? 0;
      const end = endTimeSec ?? (videoAsset.durationSec || 1);
      const dur = Math.max(0.05, end - start);

      if (this.hasReverseFrames(specId) || this.hasReverseFrames(videoAsset.id)) return;

      const sampleCount = Math.min(30, Math.max(10, Math.round(dur * 25)));
      const frames: HTMLCanvasElement[] = [];

      const video = document.createElement('video');
      video.preload = 'auto';
      video.muted = true;
      video.playsInline = true;
      video.src = videoAsset.objectUrl;

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), 2000);
        video.onloadeddata = () => {
          clearTimeout(timer);
          resolve();
        };
        video.onerror = () => {
          clearTimeout(timer);
          reject();
        };
      });

      const w = video.videoWidth || 1280;
      const h = video.videoHeight || 720;

      for (let i = 0; i < sampleCount; i++) {
        const targetTime = start + ((i / (sampleCount - 1)) * (dur - start));
        if (Math.abs(video.currentTime - targetTime) > 0.02) {
          video.currentTime = targetTime;
          await new Promise<void>((resolve) => {
            const seekTimer = setTimeout(resolve, 60);
            video.onseeked = () => {
              clearTimeout(seekTimer);
              resolve();
            };
          });
        }
        const offscreen = document.createElement('canvas');
        offscreen.width = w;
        offscreen.height = h;
        const offCtx = offscreen.getContext('2d');
        if (offCtx) {
          offCtx.drawImage(video, 0, 0, w, h);
          frames.push(offscreen);
        }
      }

      video.pause();
      video.removeAttribute('src');
      video.load();

      if (frames.length > 0 && !this.hasReverseFrames(specId)) {
        this.storeReverseFrames(specId, frames);
        if (typeof startTimeSec === 'undefined' && typeof endTimeSec === 'undefined') {
          this.storeReverseFrames(videoAsset.id, frames);
        }
      }
    } catch {
      // Ignored: runtime capture will handle it
    }
  }

  private ensureImageLoaded(assetId: string, objectUrl: string): Promise<HTMLImageElement> {
    const existing = this.imageCache.get(assetId);
    if (existing && existing.complete) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        this.imageCache.set(assetId, img);
        resolve(img);
      };
      img.onerror = () => {
        resolve(img);
      };
      img.src = objectUrl;
    });
  }

  private ensureVideoWarmed(assetId: string, objectUrl: string): Promise<HTMLVideoElement> {
    const existing = this.videoCache.get(assetId);
    if (existing && existing.readyState >= 2) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve) => {
      const video = existing || document.createElement('video');
      video.preload = 'auto';
      video.playsInline = true;
      video.muted = true;

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.videoCache.set(assetId, video);
        resolve(video);
      };

      const timer = window.setTimeout(finish, 3000);
      video.onloadeddata = () => {
        window.clearTimeout(timer);
        finish();
      };
      video.onerror = () => {
        window.clearTimeout(timer);
        finish();
      };

      if (video.src !== objectUrl) {
        video.src = objectUrl;
        video.load();
      } else if (video.readyState >= 2) {
        window.clearTimeout(timer);
        finish();
      }
    });
  }

  private easeInOutCubic(x: number): number {
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  }
}
