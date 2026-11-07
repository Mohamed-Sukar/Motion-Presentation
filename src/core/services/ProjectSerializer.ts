import { PresentationProject, PresentationSettings } from '../domain/types';

const STORAGE_KEY = 'motion_presentation_settings_v1';

export class ProjectSerializer {
  static saveSettingsToLocal(settings: PresentationSettings): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Ignore quota errors
    }
  }

  static loadSettingsFromLocal(): Partial<PresentationSettings> | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as Partial<PresentationSettings>;
    } catch {
      return null;
    }
  }

  static exportProjectManifest(project: PresentationProject): void {
    const manifest = {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      title: project.title,
      settings: project.settings,
      slides: project.slides.map((s, idx) => ({
        index: idx + 1,
        title: s.title,
        notes: s.notes,
        holdDurationSec: s.holdDurationSec,
        imageFileName: s.imageAsset.name,
        imageResolution: `${s.imageAsset.width}x${s.imageAsset.height}`,
        imageThumbnailUrl: s.imageAsset.thumbnailUrl?.startsWith('data:') ? s.imageAsset.thumbnailUrl : undefined,
        transitionToNext: {
          hasCustomVideo: Boolean(s.transitionToNext.videoAsset),
          videoFileName: s.transitionToNext.videoAsset?.name || null,
          videoDurationSec: s.transitionToNext.videoAsset?.durationSec || 0,
          startTimeSec: s.transitionToNext.startTimeSec,
          endTimeSec: s.transitionToNext.endTimeSec,
          videoThumbnailUrl: s.transitionToNext.videoAsset?.thumbnailUrl?.startsWith('data:') ? s.transitionToNext.videoAsset.thumbnailUrl : undefined,
          fallbackStyle: s.transitionToNext.fallbackStyle,
          fallbackDurationMs: s.transitionToNext.fallbackDurationMs,
          playbackSpeed: s.transitionToNext.playbackSpeed,
          muted: s.transitionToNext.muted,
        },
      })),
    };

    const json = JSON.stringify(manifest, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = project.title.replace(/[\\/:*?"<>|]/g, '_') || 'presentation';
    a.download = `${safeName}.mpres.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  static deserializeProject(jsonString: string): {
    title: string;
    settings?: Partial<PresentationSettings>;
    slidesData: Array<{
      index: number;
      title: string;
      notes: string;
      holdDurationSec: number | null;
      imageFileName: string;
      imageResolution?: string;
      transitionToNext?: {
        hasCustomVideo?: boolean;
        videoFileName?: string | null;
        videoDurationSec?: number;
        startTimeSec?: number;
        endTimeSec?: number;
        fallbackStyle?: string;
        fallbackDurationMs?: number;
        playbackSpeed?: number;
        muted?: boolean;
      };
    }>;
  } {
    const data = JSON.parse(jsonString);
    if (!data || typeof data !== 'object') {
      throw new Error('ملف المشروع غير صالح أو تالف.');
    }
    const title = typeof data.title === 'string' ? data.title : 'عرض مستورد';
    const settings =
      data.settings && typeof data.settings === 'object' ? data.settings : undefined;
    const slidesData = Array.isArray(data.slides) ? data.slides : [];
    return { title, settings, slidesData };
  }

  static async readProjectFile(file: File): Promise<{
    title: string;
    settings?: Partial<PresentationSettings>;
    slidesData: any[];
  }> {
    const text = await file.text();
    return this.deserializeProject(text);
  }
}
