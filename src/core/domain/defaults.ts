import {
  FallbackTransitionStyle,
  MediaAsset,
  PresentationProject,
  PresentationSettings,
  SlideNode,
  TransitionSpec,
} from './types';

export function generateId(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createDefaultSettings(): PresentationSettings {
  return {
    aspectRatio: '16:9',
    fitMode: 'contain',
    stageBackground: '#05070B',
    globalPlaybackSpeed: 1.0,
    interruptBehavior: 'skip',
    backwardBehavior: 'reverse-step',
    defaultFallbackStyle: 'crossfade',
    defaultFallbackDurationMs: 650,
    masterMuted: false,
    masterVolume: 0.9,
    loopPresentation: false,
    showPresenterHud: 'minimal',
    autoHideCursor: true,
    preloadStrategy: 'adjacent',
  };
}

export function createDefaultTransition(
  fallbackStyle: FallbackTransitionStyle = 'crossfade',
  videoAsset: MediaAsset | null = null
): TransitionSpec {
  return {
    id: generateId('tr'),
    videoAsset,
    fallbackStyle,
    fallbackDurationMs: 650,
    playbackSpeed: 1.0,
    muted: false,
  };
}

export function createSlideNode(
  imageAsset: MediaAsset,
  index: number,
  fallbackStyle: FallbackTransitionStyle = 'crossfade'
): SlideNode {
  const cleanTitle = imageAsset.name.replace(/\.[^/.]+$/, '');
  return {
    id: generateId('slide'),
    title: cleanTitle || `شريحة ${index + 1}`,
    notes: '',
    imageAsset,
    holdDurationSec: null,
    transitionToNext: createDefaultTransition(fallbackStyle),
  };
}

export function createEmptyProject(title = 'عرض تقديمي حركي جديد'): PresentationProject {
  const now = new Date().toISOString();
  return {
    id: generateId('proj'),
    title,
    createdAt: now,
    updatedAt: now,
    slides: [],
    settings: createDefaultSettings(),
  };
}
