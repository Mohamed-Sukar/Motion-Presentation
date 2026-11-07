export type MediaKind = 'image' | 'video';

export type FallbackTransitionStyle = 'crossfade' | 'zoom-morph' | 'slide-push' | 'cut';

export type InterruptBehavior = 'lock' | 'skip' | 'fast-forward';

/**
 * Backward navigation behavior:
 * - 'reverse-step': Mirrors the previous slide's transition spec in true reverse (e.g. reverse zoom-morph or reverse slide-push)
 * - 'crossfade': Standard smooth crossfade back to the previous slide
 * - 'instant': Immediate jump back without animation
 */
export type BackwardBehavior = 'reverse-step' | 'crossfade' | 'instant';

export type AspectRatioOption = '16:9' | '16:10' | '4:3' | '9:16';

export type FitMode = 'contain' | 'cover';

export type HudVisibility = 'minimal' | 'progress-bar' | 'hidden';

export interface MediaAsset {
  id: string;
  name: string;
  kind: MediaKind;
  mimeType: string;
  extension: string;
  objectUrl: string;
  fileSize: number;
  width: number;
  height: number;
  durationSec: number;
  thumbnailUrl: string;
  lastFrameUrl?: string;
  rawFile?: File | Blob;
}

export interface TransitionSpec {
  id: string;
  videoAsset: MediaAsset | null;
  fallbackStyle: FallbackTransitionStyle;
  fallbackDurationMs: number;
  playbackSpeed: number;
  muted: boolean;
  startTimeSec?: number;
  endTimeSec?: number;
}

export interface SlideNode {
  id: string;
  title: string;
  notes: string;
  imageAsset: MediaAsset;
  holdDurationSec: number | null; // null = manual advance (click/space/arrow)
  transitionToNext: TransitionSpec;
}

export interface PresentationSettings {
  aspectRatio: AspectRatioOption;
  fitMode: FitMode;
  stageBackground: string;
  globalPlaybackSpeed: number;
  interruptBehavior: InterruptBehavior;
  backwardBehavior: BackwardBehavior;
  defaultFallbackStyle: FallbackTransitionStyle;
  defaultFallbackDurationMs: number;
  masterMuted: boolean;
  masterVolume: number;
  loopPresentation: boolean;
  showPresenterHud: HudVisibility;
  autoHideCursor: boolean;
  preloadStrategy: 'all' | 'adjacent';
}

export interface PresentationProject {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  slides: SlideNode[];
  settings: PresentationSettings;
}

export type PlaybackPhase =
  | 'IDLE'
  | 'PRELOADING'
  | 'HOLDING_SLIDE'
  | 'PLAYING_TRANSITION'
  | 'BLACKOUT';

export interface EngineStatus {
  phase: PlaybackPhase;
  currentSlideIndex: number;
  targetSlideIndex: number | null;
  transitionProgress: number; // 0..1
  preloadProgress: number; // 0..1
  activeTransitionHasVideo: boolean;
  isFastForwarding: boolean;
  errorMessage: string | null;
}

export interface ValidationResult {
  valid: boolean;
  kind: MediaKind | null;
  extension: string;
  errorReason?: string;
}

export interface BatchImportReport {
  slidesAdded: number;
  transitionsMatched: number;
  rejectedFiles: Array<{ name: string; reason: string }>;
}
