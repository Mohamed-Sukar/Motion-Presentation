import { createEmptyProject, createSlideNode, generateId } from '../domain/defaults';
import {
  MediaAsset,
  PresentationProject,
  PresentationSettings,
  SlideNode,
  TransitionSpec,
} from '../domain/types';
import { StagePlaybackEngine } from '../engine/StagePlaybackEngine';
import { DemoGenerator } from '../services/DemoGenerator';
import { FrameExtractor } from '../services/FrameExtractor';
import { ProjectSerializer } from '../services/ProjectSerializer';
import { SmartPairer } from '../services/SmartPairer';

export type SelectionTarget =
  | { type: 'slide'; slideId: string }
  | { type: 'transition'; slideId: string }
  | { type: 'settings' };

export type StoreChangeType =
  | 'structural'
  | 'settings'
  | 'metadata'
  | 'selection'
  | 'notification';

export type StoreListener = (changeType?: StoreChangeType) => void;

export class PresentationStore {
  private project: PresentationProject;
  private selection: SelectionTarget = { type: 'settings' };
  private activePreviewIndex = 0;
  private listeners = new Set<StoreListener>();
  private notification: { message: string; kind: 'info' | 'success' | 'warning' | 'error' } | null =
    null;
  private isBatching = false;

  constructor() {
    this.project = createEmptyProject('عرض Motion Graphics التفاعلي');
    const savedSettings = ProjectSerializer.loadSettingsFromLocal();
    if (savedSettings) {
      this.project.settings = { ...this.project.settings, ...savedSettings };
    }
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(changeType: StoreChangeType = 'structural'): void {
    if (this.isBatching) return;
    this.project.updatedAt = new Date().toISOString();
    for (const listener of this.listeners) {
      listener(changeType);
    }
  }

  batchUpdate(fn: () => void): void {
    this.isBatching = true;
    try {
      fn();
    } finally {
      this.isBatching = false;
      this.emit('structural');
    }
  }

  getProject(): PresentationProject {
    return this.project;
  }

  getSlides(): SlideNode[] {
    return this.project.slides;
  }

  getSettings(): PresentationSettings {
    return this.project.settings;
  }

  getSelection(): SelectionTarget {
    return this.selection;
  }

  getActivePreviewIndex(): number {
    return this.activePreviewIndex;
  }

  getNotification() {
    return this.notification;
  }

  notify(
    message: string,
    kind: 'info' | 'success' | 'warning' | 'error' = 'info',
    autoClearMs = 4500
  ): void {
    this.notification = { message, kind };
    this.emit('notification');
    if (autoClearMs > 0) {
      setTimeout(() => {
        if (this.notification?.message === message) {
          this.notification = null;
          this.emit('notification');
        }
      }, autoClearMs);
    }
  }

  setProjectTitle(title: string): void {
    this.project.title = title.trim() || 'عرض بدون عنوان';
    this.emit('metadata');
  }

  setSelection(target: SelectionTarget): void {
    this.selection = target;
    if (target.type === 'slide' || target.type === 'transition') {
      const idx = this.project.slides.findIndex((s) => s.id === target.slideId);
      if (idx !== -1) {
        this.activePreviewIndex = idx;
      }
    }
    this.emit('selection');
  }

  setActivePreviewIndex(index: number): void {
    if (this.project.slides.length === 0) {
      this.activePreviewIndex = 0;
    } else {
      this.activePreviewIndex = Math.max(
        0,
        Math.min(index, this.project.slides.length - 1)
      );
    }
    this.emit('selection');
  }

  addSlideFromImage(imageAsset: MediaAsset, insertAfterIndex?: number): SlideNode {
    const newSlide = createSlideNode(
      imageAsset,
      this.project.slides.length,
      this.project.settings.defaultFallbackStyle
    );
    newSlide.transitionToNext.fallbackDurationMs =
      this.project.settings.defaultFallbackDurationMs;

    if (
      typeof insertAfterIndex === 'number' &&
      insertAfterIndex >= 0 &&
      insertAfterIndex < this.project.slides.length
    ) {
      this.project.slides.splice(insertAfterIndex + 1, 0, newSlide);
      this.activePreviewIndex = insertAfterIndex + 1;
    } else {
      this.project.slides.push(newSlide);
      this.activePreviewIndex = this.project.slides.length - 1;
    }

    this.selection = { type: 'slide', slideId: newSlide.id };
    this.emit('structural');
    return newSlide;
  }

  appendBatchSlides(newSlides: SlideNode[], unpairedVideos: MediaAsset[] = []): void {
    const startIdx = this.project.slides.length;
    this.project.slides.push(...newSlides);

    // Smart-pair unpaired videos to existing slides by filename / numeric prefixes
    const remainingVideos: MediaAsset[] = [];
    for (const vid of unpairedVideos) {
      let matched = false;
      const targetIdx = SmartPairer.extractSlideIndexFromFilename(vid.name);
      if (
        targetIdx !== null &&
        targetIdx >= 0 &&
        targetIdx < this.project.slides.length &&
        !this.project.slides[targetIdx].transitionToNext.videoAsset
      ) {
        this.project.slides[targetIdx].transitionToNext.videoAsset = vid;
        matched = true;
      }
      if (!matched) {
        remainingVideos.push(vid);
      }
    }

    // For any remaining videos, fill slides without transition video sequentially
    let vidCursor = 0;
    for (let i = 0; i < this.project.slides.length && vidCursor < remainingVideos.length; i++) {
      if (!this.project.slides[i].transitionToNext.videoAsset) {
        this.project.slides[i].transitionToNext.videoAsset = remainingVideos[vidCursor++];
      }
    }

    if (this.project.slides.length > 0) {
      const selectSlide = this.project.slides[startIdx] || this.project.slides[0];
      this.selection = { type: 'slide', slideId: selectSlide.id };
      this.activePreviewIndex = Math.min(startIdx, this.project.slides.length - 1);
    }
    this.emit('structural');
  }

  async applyVideoCuePointsWorkflow(
    videoAsset: MediaAsset,
    cueTimesSec: number[],
    appendToExisting = false
  ): Promise<SlideNode[]> {
    const newSlides = await SmartPairer.buildSlidesFromVideoCuePoints(
      videoAsset,
      cueTimesSec,
      this.project.settings.defaultFallbackStyle
    );

    this.batchUpdate(() => {
      if (!appendToExisting) {
        for (const slide of this.project.slides) {
          safeRevokeUrl(slide.imageAsset.objectUrl);
          const oldVideoUrl = slide.transitionToNext.videoAsset?.objectUrl;
          if (oldVideoUrl !== videoAsset.objectUrl) {
            safeRevokeUrl(oldVideoUrl);
          }
        }
        this.project.slides = [];
      }
      const startIdx = this.project.slides.length;
      this.project.slides.push(...newSlides);
      this.activePreviewIndex = startIdx;
      this.selection = { type: 'slide', slideId: newSlides[0].id };
      this.notify('تم إنشاء شرائح العرض ومراحل التوقف من الفيديو بنجاح', 'success');
    });

    return newSlides;
  }

  replaceSlideImage(slideId: string, newImageAsset: MediaAsset): void {
    const slide = this.project.slides.find((s) => s.id === slideId);
    if (!slide) return;
    const oldUrl = slide.imageAsset.objectUrl;
    slide.imageAsset = newImageAsset;
    if (oldUrl !== newImageAsset.objectUrl) {
      safeRevokeUrl(oldUrl);
    }
    this.emit('structural');
  }

  setSlideTransitionVideo(slideId: string, videoAsset: MediaAsset | null): void {
    const slide = this.project.slides.find((s) => s.id === slideId);
    if (!slide) return;
    const oldUrl = slide.transitionToNext.videoAsset?.objectUrl;
    slide.transitionToNext.videoAsset = videoAsset;
    if (oldUrl && oldUrl !== videoAsset?.objectUrl) {
      safeRevokeUrl(oldUrl);
    }
    this.selection = { type: 'transition', slideId: slide.id };
    this.emit('structural');
  }

  async splitTransitionAtTime(slideId: string, splitTimeSec?: number): Promise<SlideNode | null> {
    const idx = this.project.slides.findIndex((s) => s.id === slideId);
    if (idx === -1) return null;
    const slide = this.project.slides[idx];
    const videoAsset = slide.transitionToNext.videoAsset;
    if (!videoAsset) {
      this.notify('لا يوجد فيديو انتقال مرتبط بهذه الشريحة لتقسيمه', 'warning');
      return null;
    }

    const start = slide.transitionToNext.startTimeSec ?? 0;
    const end = slide.transitionToNext.endTimeSec ?? (videoAsset.durationSec || 1);
    const mid = typeof splitTimeSec === 'number' && splitTimeSec > start + 0.08 && splitTimeSec < end - 0.08
      ? splitTimeSec
      : Number(((start + end) / 2).toFixed(2));
    const extractedFrame = await FrameExtractor.extractFrameAtTimeAsSlideAsset(
      videoAsset,
      mid,
      `توقف_${mid.toFixed(1)}s.png`
    );

    let newSlide!: SlideNode;
    this.batchUpdate(() => {
      slide.transitionToNext.startTimeSec = start;
      slide.transitionToNext.endTimeSec = mid;
      newSlide = this.addSlideFromImage(extractedFrame, idx);
      newSlide.title = `مرحلة توقف (${mid.toFixed(2)}s)`;
      newSlide.transitionToNext.videoAsset = videoAsset;
      newSlide.transitionToNext.startTimeSec = mid;
      newSlide.transitionToNext.endTimeSec = end;
      newSlide.transitionToNext.playbackSpeed = slide.transitionToNext.playbackSpeed;
      newSlide.transitionToNext.muted = slide.transitionToNext.muted;
    });
    return newSlide;
  }

  async generateTransitionVideoForSlide(slideId: string): Promise<boolean> {
    const idx = this.project.slides.findIndex((s) => s.id === slideId);
    if (idx === -1) return false;
    const nextIdx = idx + 1 < this.project.slides.length
      ? idx + 1
      : (this.project.settings.loopPresentation && this.project.slides.length > 1 ? 0 : -1);
    if (nextIdx === -1) {
      this.notify('أضف شريحة تالية أولاً لتوليد فيديو انتقال بينهما', 'warning');
      return false;
    }

    const slide = this.project.slides[idx];
    const { videoAsset, reverseFrames } = await DemoGenerator.generateTransitionVideoBetweenSlides(
      slide,
      this.project.slides[nextIdx],
      slide.transitionToNext.fallbackStyle,
      slide.transitionToNext.fallbackDurationMs || 900
    );
    slide.transitionToNext.videoAsset = videoAsset;
    slide.transitionToNext.startTimeSec = undefined;
    slide.transitionToNext.endTimeSec = undefined;
    StagePlaybackEngine.cacheReverseFrames(slide.transitionToNext.id, reverseFrames);
    StagePlaybackEngine.cacheReverseFrames(videoAsset.id, reverseFrames);
    this.emit('structural');
    this.notify('تم توليد وربط فيديو الانتقال الحركي بنجاح', 'success');
    return true;
  }

  async extractNextSlideFromTransitionEnd(slideId: string): Promise<SlideNode | null> {
    const idx = this.project.slides.findIndex((s) => s.id === slideId);
    if (idx === -1) return null;
    const slide = this.project.slides[idx];
    const videoAsset = slide.transitionToNext.videoAsset;
    if (!videoAsset) {
      this.notify('لا يوجد فيديو انتقال مرتبط بهذه الشريحة لاستخراج الفريم منه.', 'warning');
      return null;
    }

    try {
      const extractedImage = await FrameExtractor.extractFrameAsSlideAsset(
        videoAsset,
        'last',
        `شريحة_مستخرجة_${idx + 2}.png`
      );
      const created = this.addSlideFromImage(extractedImage, idx);
      created.title = `شريحة ${idx + 2} (من نهاية الفيديو)`;
      this.notify('تم استخراج الفريم الأخير من الفيديو وإضافته كشريحة تالية بنجاح!', 'success');
      return created;
    } catch (err) {
      this.notify(
        err instanceof Error ? err.message : 'فشل استخراج الفريم من الفيديو',
        'error'
      );
      return null;
    }
  }

  updateSlideDetails(
    slideId: string,
    patch: Partial<Pick<SlideNode, 'title' | 'notes' | 'holdDurationSec'>>
  ): void {
    const slide = this.project.slides.find((s) => s.id === slideId);
    if (!slide) return;
    if (patch.title !== undefined) slide.title = patch.title;
    if (patch.notes !== undefined) slide.notes = patch.notes;
    if (patch.holdDurationSec !== undefined) slide.holdDurationSec = patch.holdDurationSec;
    this.emit('metadata');
  }

  updateTransitionSpec(
    slideId: string,
    patch: Partial<Omit<TransitionSpec, 'id' | 'videoAsset'>>
  ): void {
    const slide = this.project.slides.find((s) => s.id === slideId);
    if (!slide) return;
    slide.transitionToNext = {
      ...slide.transitionToNext,
      ...patch,
    };
    this.emit('metadata');
  }

  moveSlide(slideId: string, direction: 'up' | 'down'): void {
    const idx = this.project.slides.findIndex((s) => s.id === slideId);
    if (idx === -1) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= this.project.slides.length) return;

    const [removed] = this.project.slides.splice(idx, 1);
    this.project.slides.splice(targetIdx, 0, removed);
    this.activePreviewIndex = targetIdx;
    this.emit('structural');
  }

  deleteSlide(slideId: string): void {
    const idx = this.project.slides.findIndex((s) => s.id === slideId);
    if (idx === -1) return;
    const [removed] = this.project.slides.splice(idx, 1);
    if (removed) {
      safeRevokeUrl(removed.imageAsset?.objectUrl);
      safeRevokeUrl(removed.transitionToNext?.videoAsset?.objectUrl);
    }

    if (this.project.slides.length === 0) {
      this.activePreviewIndex = 0;
      this.selection = { type: 'settings' };
    } else {
      this.activePreviewIndex = Math.max(0, Math.min(idx, this.project.slides.length - 1));
      this.selection = {
        type: 'slide',
        slideId: this.project.slides[this.activePreviewIndex].id,
      };
    }
    this.emit('structural');
  }

  clearAllSlides(): void {
    for (const slide of this.project.slides) {
      safeRevokeUrl(slide.imageAsset?.objectUrl);
      safeRevokeUrl(slide.transitionToNext?.videoAsset?.objectUrl);
    }
    this.project.slides = [];
    this.activePreviewIndex = 0;
    this.selection = { type: 'settings' };
    this.emit('structural');
  }

  updateSettings(patch: Partial<PresentationSettings>): void {
    this.project.settings = {
      ...this.project.settings,
      ...patch,
    };
    ProjectSerializer.saveSettingsToLocal(this.project.settings);
    this.emit('settings');
  }

  loadProjectFromManifest(data: {
    title?: string;
    settings?: Partial<PresentationSettings>;
    slides?: SlideNode[];
    slidesData?: any[];
  }): void {
    // Revoke previous slide object URLs to prevent memory leaks
    for (const s of this.project.slides) {
      safeRevokeUrl(s.imageAsset?.objectUrl);
      safeRevokeUrl(s.transitionToNext?.videoAsset?.objectUrl);
    }

    if (data.title) this.project.title = data.title;
    if (data.settings) {
      this.project.settings = { ...this.project.settings, ...data.settings };
      ProjectSerializer.saveSettingsToLocal(this.project.settings);
    }

    if (Array.isArray(data.slides) && data.slides.length > 0 && 'imageAsset' in data.slides[0]) {
      this.project.slides = data.slides;
    } else if (Array.isArray(data.slidesData) && data.slidesData.length > 0) {
      this.project.slides = data.slidesData.map((sd: any, i: number) => {
        const title = sd.title || `شريحة ${i + 1}`;
        const fileName = sd.imageFileName || `slide_${i + 1}.png`;
        const thumb =
          sd.imageThumbnailUrl ||
          createPlaceholderSlideImage(title, fileName, i + 1).thumbnailUrl;

        const imgAsset: MediaAsset = {
          id: generateId('img'),
          name: fileName,
          kind: 'image',
          mimeType: 'image/png',
          extension: 'png',
          objectUrl: thumb,
          fileSize: 0,
          width: 1920,
          height: 1080,
          durationSec: 0,
          thumbnailUrl: thumb,
        };

        const slide = createSlideNode(
          imgAsset,
          i,
          sd.transitionToNext?.fallbackStyle || this.project.settings.defaultFallbackStyle
        );
        slide.title = title;
        slide.notes = sd.notes || '';
        slide.holdDurationSec =
          typeof sd.holdDurationSec === 'number' ? sd.holdDurationSec : null;

        if (sd.transitionToNext) {
          slide.transitionToNext.fallbackDurationMs =
            sd.transitionToNext.fallbackDurationMs ||
            this.project.settings.defaultFallbackDurationMs;
          slide.transitionToNext.playbackSpeed =
            sd.transitionToNext.playbackSpeed || 1.0;
          slide.transitionToNext.muted = Boolean(sd.transitionToNext.muted);
          // Restore time-slice / cue-point segment support
          slide.transitionToNext.startTimeSec =
            typeof sd.transitionToNext?.startTimeSec === 'number' && !Number.isNaN(sd.transitionToNext.startTimeSec) ? sd.transitionToNext.startTimeSec : undefined;
          slide.transitionToNext.endTimeSec =
            typeof sd.transitionToNext?.endTimeSec === 'number' && !Number.isNaN(sd.transitionToNext.endTimeSec) ? sd.transitionToNext.endTimeSec : undefined;
        }

        return slide;
      });
    } else {
      this.project.slides = [];
    }

    this.activePreviewIndex = 0;
    this.selection =
      this.project.slides.length > 0
        ? { type: 'slide', slideId: this.project.slides[0].id }
        : { type: 'settings' };
    this.emit('structural');
  }
}

function createPlaceholderSlideImage(
  title: string,
  fileName: string,
  index: number
): { objectUrl: string; thumbnailUrl: string } {
  if (typeof document === 'undefined') {
    return { objectUrl: '', thumbnailUrl: '' };
  }
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createLinearGradient(0, 0, 1280, 720);
    grad.addColorStop(0, '#0F172A');
    grad.addColorStop(1, '#1E293B');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1280, 720);

    ctx.fillStyle = '#38BDF8';
    ctx.font = '700 28px Cairo, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`شريحة ${index} — ${fileName}`, 640, 330);

    ctx.fillStyle = '#94A3B8';
    ctx.font = '500 20px Cairo, -apple-system, sans-serif';
    ctx.fillText(title, 640, 390);
  }
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return { objectUrl: dataUrl, thumbnailUrl: dataUrl };
}

function safeRevokeUrl(url?: string): void {
  if (url && typeof url === 'string' && url.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
}
