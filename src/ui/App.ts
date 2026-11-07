import {
  AspectRatioOption,
  BackwardBehavior,
  EngineStatus,
  FallbackTransitionStyle,
  FitMode,
  HudVisibility,
  InterruptBehavior,
  PresentationSettings,
} from '../core/domain/types';
import { StagePlaybackEngine } from '../core/engine/StagePlaybackEngine';
import { DemoGenerator } from '../core/services/DemoGenerator';
import {
  ALL_MEDIA_ACCEPT_STRING,
  IMAGE_ACCEPT_STRING,
  MediaValidator,
  VIDEO_ACCEPT_STRING,
} from '../core/services/MediaValidator';
import { ProjectSerializer } from '../core/services/ProjectSerializer';
import { SmartPairer } from '../core/services/SmartPairer';
import { PresentationStore, StoreChangeType } from '../core/state/PresentationStore';
import { Icons } from './icons';

declare global {
  interface Window {
    desktopAPI?: {
      isDesktopApp: boolean;
      setFullScreen: (flag: boolean) => Promise<boolean>;
      isFullScreen: () => Promise<boolean>;
      openProjectDialog?: () => Promise<{ filePath: string; content: string; fileName: string } | null>;
      openMediaDialog?: () => Promise<Array<{ fileName: string; mimeType: string; buffer: ArrayBuffer }> | null>;
      onMenuCommand?: (callback: (command: string) => void) => void;
    };
  }
}

export class MotionPresentationApp {
  private root: HTMLElement;
  private store: PresentationStore;

  private previewCanvas!: HTMLCanvasElement;
  private previewEngine!: StagePlaybackEngine;
  private latestEngineStatus!: EngineStatus;

  private isNavigatorVisible = true;
  private isInspectorVisible = true;
  private isPresentingFullscreen = false;
  private isSlideGridOpen = false;
  private isPresenterNotesOpen = false;
  private isGeneratingDemo = false;
  private presenterCursorTimer: number | null = null;
  private presenterOverlayEl: HTMLElement | null = null;
  private presenterEngine: StagePlaybackEngine | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.store = new PresentationStore();
    this.mountInitialShell();
    this.bindGlobalShortcuts();
    this.bindNativeMenuCommands();
    this.store.subscribe((changeType) => this.onStoreUpdated(changeType));
    this.onStoreUpdated();
  }

  private mountInitialShell(): void {
    this.root.innerHTML = `
      <header class="window-toolbar" id="window-toolbar" role="toolbar" aria-label="شريط الأدوات الرئيسي"></header>
      <main class="split-view">
        <aside class="navigator-pane" id="navigator-pane" aria-label="متصفح الشرائح"></aside>
        <section class="stage-pane" id="stage-pane" aria-label="منصة المعاينة">
          <div class="stage-canvas-frame" id="canvas-frame">
            <canvas class="stage-canvas" id="preview-canvas"></canvas>
          </div>
          <div class="empty-canvas-sheet" id="empty-overlay" style="display:none;"></div>
          <div class="floating-stage-hud" id="floating-stage-hud" role="region" aria-label="أدوات التحكم في التشغيل"></div>
        </section>
        <aside class="inspector-pane" id="inspector-pane" aria-label="لوحة الخصائص"></aside>
      </main>
      <div id="toast-container" aria-live="polite"></div>
      <div id="fullscreen-root"></div>
      <input type="file" id="batch-file-input" multiple accept="${ALL_MEDIA_ACCEPT_STRING}" style="display:none;" />
      <input type="file" id="single-image-input" accept="${IMAGE_ACCEPT_STRING}" style="display:none;" />
      <input type="file" id="single-video-input" accept="${VIDEO_ACCEPT_STRING}" style="display:none;" />
      <input type="file" id="project-file-input" accept=".json,.mpres.json" style="display:none;" />
    `;

    this.previewCanvas = this.root.querySelector('#preview-canvas') as HTMLCanvasElement;
    this.previewEngine = new StagePlaybackEngine(
      this.previewCanvas,
      this.store.getSettings()
    );

    this.previewEngine.onStatusChange((status) => {
      this.latestEngineStatus = status;
      this.renderFloatingStageHud();
    });

    this.previewCanvas.addEventListener('click', () => {
      if (this.store.getSlides().length > 0) {
        this.previewEngine.next();
      }
    });

    this.setupGlobalDragAndDrop();
    this.setupHiddenFileInputs();
  }

  private async onStoreUpdated(changeType?: StoreChangeType): Promise<void> {
    if (changeType === 'notification') {
      this.renderToast();
      return;
    }

    if (changeType === 'selection') {
      this.syncSelectionHighlight();
      this.renderInspectorPane();
      const targetIdx = this.store.getActivePreviewIndex();
      if (
        this.latestEngineStatus &&
        this.latestEngineStatus.currentSlideIndex !== targetIdx &&
        this.latestEngineStatus.phase !== 'PLAYING_TRANSITION'
      ) {
        this.previewEngine.jumpToSlide(targetIdx);
      }
      return;
    }

    if (changeType === 'metadata') {
      const project = this.store.getProject();
      const titleInput = this.root.querySelector('#project-title-input') as HTMLInputElement;
      if (titleInput && document.activeElement !== titleInput) {
        titleInput.value = project.title;
      }
      this.updateNavigatorCaptions();
      this.renderInspectorPane();
      return;
    }

    if (changeType === 'settings') {
      const settings = this.store.getSettings();
      this.updateCanvasFrameDimensions(settings);
      this.previewEngine.updateSettingsLive(settings);
      this.presenterEngine?.updateSettingsLive(settings);
      this.renderInspectorPane();
      return;
    }

    // Structural changes (slides added/removed, full project loaded)
    this.renderWindowToolbar();
    this.renderNavigatorPane();
    this.renderEmptyOverlay();
    this.renderInspectorPane();
    this.renderToast();

    const slides = this.store.getSlides();
    const settings = this.store.getSettings();
    const targetIdx = this.store.getActivePreviewIndex();

    this.updateCanvasFrameDimensions(settings);
    this.previewEngine.updateSettingsLive(settings);
    await this.previewEngine.loadProject(slides, settings, targetIdx);
  }

  private updateCanvasFrameDimensions(settings: PresentationSettings): void {
    const frameEl = this.root.querySelector('#canvas-frame') as HTMLElement;
    if (!frameEl) return;
    const ratioMap: Record<AspectRatioOption, { css: string; num: number }> = {
      '16:9': { css: '16 / 9', num: 16 / 9 },
      '16:10': { css: '16 / 10', num: 16 / 10 },
      '4:3': { css: '4 / 3', num: 4 / 3 },
      '9:16': { css: '9 / 16', num: 9 / 16 },
    };
    const r = ratioMap[settings.aspectRatio as AspectRatioOption] || ratioMap['16:9'];
    frameEl.style.aspectRatio = r.css;
    frameEl.style.width = `min(100%, calc((100vh - 160px) * ${r.num}))`;
  }

  private syncSelectionHighlight(): void {
    const selection = this.store.getSelection();
    this.root.querySelectorAll('.slide-nav-item').forEach((item) => {
      const id = (item as HTMLElement).dataset.slideId;
      item.classList.toggle('selected', selection.type === 'slide' && selection.slideId === id);
    });
    this.root.querySelectorAll('.filmstrip-bridge').forEach((bridge) => {
      const id = (bridge as HTMLElement).dataset.transitionSlideId;
      bridge.classList.toggle('selected', selection.type === 'transition' && selection.slideId === id);
    });
  }

  private updateNavigatorCaptions(): void {
    const slides = this.store.getSlides();
    this.root.querySelectorAll('.slide-nav-item').forEach((item) => {
      const id = (item as HTMLElement).dataset.slideId;
      const slide = slides.find((s) => s.id === id);
      if (slide) {
        const titleEl = item.querySelector('.slide-caption-title');
        if (titleEl) titleEl.textContent = slide.title;
        const metaEl = item.querySelector('.slide-caption-meta');
        if (metaEl) metaEl.textContent = slide.holdDurationSec ? `${slide.holdDurationSec}s` : '';
      }
    });
  }

  /* =========================================================================
   * 1. INTEGRATED WINDOW TOOLBAR (toolbars.md)
   * ========================================================================= */
  private renderWindowToolbar(): void {
    const toolbar = this.root.querySelector('#window-toolbar') as HTMLElement;
    if (!toolbar) return;

    const project = this.store.getProject();
    const hasSlides = project.slides.length > 0;

    toolbar.innerHTML = `
      <div class="toolbar-group-leading">
        <button
          class="btn btn-toolbar btn-icon-only ${this.isNavigatorVisible ? 'active-pane' : ''}"
          id="btn-toggle-navigator"
          title="إظهار أو إخفاء متصفح الشرائح"
          aria-label="إظهار أو إخفاء متصفح الشرائح"
        >
          ${Icons.sidebarRight}
        </button>
        <div class="toolbar-divider"></div>
        <input
          type="text"
          class="doc-title-input"
          id="project-title-input"
          value="${this.escapeHtml(project.title)}"
          aria-label="عنوان العرض"
          placeholder="عنوان العرض..."
        />
      </div>

      <div class="toolbar-group-center">
        <button class="btn btn-toolbar" id="btn-open-project" title="فتح مشروع (.mpres.json)">
          ${Icons.folderOpen}
          <span>فتح مشروع...</span>
        </button>

        <button class="btn btn-toolbar" id="btn-batch-import" title="استيراد صور الشرائح وفيديوهات الانتقال">
          ${Icons.folderImport}
          <span>استيراد وسائط...</span>
        </button>

        <button class="btn btn-toolbar" id="btn-add-slide" title="إضافة شريحة صورة ثابتة">
          ${Icons.photoPlus}
          <span>شريحة جديدة...</span>
        </button>

        <div class="toolbar-divider"></div>

        <button class="btn btn-toolbar" id="btn-load-demo" ${this.isGeneratingDemo ? 'disabled' : ''} title="توليد عرض تجريبي متكامل">
          ${Icons.sparkles}
          <span>${this.isGeneratingDemo ? 'جاري التحضير...' : 'عرض تجريبي'}</span>
        </button>

        <button class="btn btn-toolbar" id="btn-export-manifest" ${!hasSlides ? 'disabled' : ''} title="تصدير ملف المشروع (.mpres.json)">
          ${Icons.exportDoc}
          <span>حفظ المشروع...</span>
        </button>
      </div>

      <div class="toolbar-group-trailing">
        <button
          class="btn btn-toolbar btn-icon-only ${this.isInspectorVisible ? 'active-pane' : ''}"
          id="btn-toggle-inspector"
          title="إظهار أو إخفاء لوحة الخصائص"
          aria-label="إظهار أو إخفاء لوحة الخصائص"
        >
          ${Icons.sidebarLeft}
        </button>
        <button class="btn btn-prominent" id="btn-start-fullscreen" ${!hasSlides ? 'disabled' : ''} title="تشغيل العرض بملء الشاشة (F5)">
          ${Icons.playFill}
          <span>تشغيل العرض</span>
        </button>
      </div>
    `;

    const titleInput = toolbar.querySelector('#project-title-input') as HTMLInputElement;
    titleInput?.addEventListener('change', () => {
      this.store.setProjectTitle(titleInput.value);
    });

    toolbar.querySelector('#btn-toggle-navigator')?.addEventListener('click', () => {
      this.toggleNavigatorPane();
    });

    toolbar.querySelector('#btn-toggle-inspector')?.addEventListener('click', () => {
      this.toggleInspectorPane();
    });

    toolbar.querySelector('#btn-open-project')?.addEventListener('click', () => {
      this.handleOpenProject();
    });

    toolbar.querySelector('#btn-load-demo')?.addEventListener('click', () => {
      this.handleGenerateDemo();
    });

    toolbar.querySelector('#btn-batch-import')?.addEventListener('click', () => {
      this.handleImportMedia();
    });

    toolbar.querySelector('#btn-add-slide')?.addEventListener('click', () => {
      const input = this.root.querySelector('#single-image-input') as HTMLInputElement;
      input.dataset.replaceSlideId = '';
      input.click();
    });

    toolbar.querySelector('#btn-export-manifest')?.addEventListener('click', () => {
      ProjectSerializer.exportProjectManifest(this.store.getProject());
      this.store.notify('تم حفظ ملف المشروع (.mpres.json)', 'success');
    });

    toolbar.querySelector('#btn-start-fullscreen')?.addEventListener('click', () => {
      this.enterFullscreenPresentation(this.latestEngineStatus?.currentSlideIndex || 0);
    });
  }

  private toggleNavigatorPane(): void {
    this.isNavigatorVisible = !this.isNavigatorVisible;
    const navPane = this.root.querySelector('#navigator-pane');
    navPane?.classList.toggle('collapsed', !this.isNavigatorVisible);
    const btn = this.root.querySelector('#btn-toggle-navigator');
    btn?.classList.toggle('active-pane', this.isNavigatorVisible);
  }

  private toggleInspectorPane(): void {
    this.isInspectorVisible = !this.isInspectorVisible;
    const inspPane = this.root.querySelector('#inspector-pane');
    inspPane?.classList.toggle('collapsed', !this.isInspectorVisible);
    const btn = this.root.querySelector('#btn-toggle-inspector');
    btn?.classList.toggle('active-pane', this.isInspectorVisible);
  }

  private async handleOpenProject(): Promise<void> {
    try {
      if (window.desktopAPI?.openProjectDialog) {
        const res = await window.desktopAPI.openProjectDialog();
        if (!res) return;
        const projectData = ProjectSerializer.deserializeProject(res.content);
        this.store.loadProjectFromManifest(projectData);
        this.store.notify(`تم فتح المشروع: ${projectData.title}`, 'success');
      } else {
        const input = this.root.querySelector('#project-file-input') as HTMLInputElement;
        input?.click();
      }
    } catch (err) {
      this.store.notify(
        err instanceof Error ? err.message : 'فشل فتح ملف المشروع',
        'error'
      );
    }
  }

  private async handleImportMedia(): Promise<void> {
    if (window.desktopAPI?.openMediaDialog) {
      try {
        const selected = await window.desktopAPI.openMediaDialog();
        if (selected && selected.length > 0) {
          const files = selected.map(
            (item) => new File([item.buffer], item.fileName, { type: item.mimeType })
          );
          await this.handleBatchFiles(files);
        }
      } catch (err) {
        this.store.notify(
          err instanceof Error ? err.message : 'فشل استيراد الوسائط',
          'error'
        );
      }
    } else {
      (this.root.querySelector('#batch-file-input') as HTMLInputElement)?.click();
    }
  }

  /* =========================================================================
   * 2. LEADING PANE: KEYNOTE NAVIGATOR + MAGNETIC FILMSTRIP BRIDGE
   * ========================================================================= */
  private renderNavigatorPane(): void {
    const pane = this.root.querySelector('#navigator-pane') as HTMLElement;
    if (!pane) return;

    pane.classList.toggle('collapsed', !this.isNavigatorVisible);

    const slides = this.store.getSlides();
    const selection = this.store.getSelection();
    const activeIdx = this.latestEngineStatus?.currentSlideIndex ?? 0;

    const fallbackShortNames: Record<FallbackTransitionStyle, string> = {
      crossfade: 'تلاشي',
      'zoom-morph': 'تقريب',
      'slide-push': 'إزاحة',
      cut: 'قطع فوري',
    };

    let listHtml = '';
    slides.forEach((slide, idx) => {
      const isSlideSelected =
        selection.type === 'slide' && selection.slideId === slide.id;
      const isTransSelected =
        selection.type === 'transition' && selection.slideId === slide.id;
      const isActiveOnStage = idx === activeIdx && slides.length > 0;
      const isLastSlide = idx === slides.length - 1;
      const vid = slide.transitionToNext.videoAsset;

      listHtml += `
        <div
          class="slide-nav-item ${isSlideSelected ? 'selected' : ''}"
          data-slide-id="${slide.id}"
          tabindex="0"
          role="button"
          aria-label="الشريحة ${idx + 1}: ${this.escapeHtml(slide.title)}"
        >
          <div class="slide-gutter-col">
            <span class="slide-num">${idx + 1}</span>
            ${isActiveOnStage ? `<span class="live-stage-dot" title="معروضة حالياً"></span>` : ''}
          </div>
          <div class="slide-card-body">
            <div class="slide-thumb-frame">
              <img src="${slide.imageAsset.thumbnailUrl || slide.imageAsset.objectUrl}" alt="${this.escapeHtml(slide.title)}" />
              <div class="slide-hover-actions">
                <button class="mini-action-btn btn-move-up" data-id="${slide.id}" title="تحريك لأعلى" aria-label="تحريك الشريحة لأعلى" ${idx === 0 ? 'disabled' : ''}>
                  ${Icons.chevronUp}
                </button>
                <button class="mini-action-btn btn-move-down" data-id="${slide.id}" title="تحريك لأسفل" aria-label="تحريك الشريحة لأسفل" ${isLastSlide ? 'disabled' : ''}>
                  ${Icons.chevronDown}
                </button>
                <button class="mini-action-btn btn-delete-slide" data-id="${slide.id}" title="حذف الشريحة" aria-label="حذف الشريحة">
                  ${Icons.trash}
                </button>
              </div>
            </div>
            <div class="slide-caption-row">
              <span class="slide-caption-title">${this.escapeHtml(slide.title)}</span>
              <span class="slide-caption-meta">${slide.holdDurationSec ? `${slide.holdDurationSec}s` : ''}</span>
            </div>
          </div>
        </div>
      `;

      // Render Magnetic Filmstrip Transition Bridge between Slide[idx] and Slide[idx+1]
      if (!isLastSlide || this.store.getSettings().loopPresentation || vid) {
        listHtml += `
          <div
            class="filmstrip-bridge ${vid ? 'has-video' : ''} ${isTransSelected ? 'selected' : ''}"
            data-transition-slide-id="${slide.id}"
          >
            <div
              class="filmstrip-pill"
              tabindex="0"
              role="button"
              aria-label="الانتقال بعد الشريحة ${idx + 1}"
              title="انقر لضبط الانتقال أو اسحب ملف فيديو MP4/WebM هنا"
            >
              <div class="filmstrip-pill-lead">
                ${
                  vid
                    ? `
                  <span class="filmstrip-dual-thumb">
                    <img src="${vid.thumbnailUrl}" alt="" />
                    <img src="${vid.lastFrameUrl || vid.thumbnailUrl}" alt="" />
                  </span>
                  <span class="filmstrip-text">${this.escapeHtml(vid.name)}</span>
                `
                    : `
                  <span class="filmstrip-icon-badge">${Icons.filmTransition}</span>
                  <span class="filmstrip-text">+ ربط فيديو انتقال</span>
                `
                }
              </div>
              ${
                vid
                  ? `<span class="filmstrip-timecode">${vid.durationSec.toFixed(1)}s</span>`
                  : `<span class="filmstrip-fallback-tag">${fallbackShortNames[slide.transitionToNext.fallbackStyle]}</span>`
              }
            </div>
          </div>
        `;
      }
    });

    pane.innerHTML = `
      <div class="pane-subheader">
        <span>الشرائح والانتقالات</span>
        <span class="tabular-nums">${slides.length}</span>
      </div>
      <div class="navigator-list">
        ${
          slides.length > 0
            ? listHtml
            : `
          <div style="padding: 32px 12px; text-align: center; color: var(--label-tertiary); font-size: 12px; line-height: 1.6;">
            لا توجد شرائح بعد.<br/>أضف صوراً وفيديوهات من شريط الأدوات.
          </div>
        `
        }
      </div>
    `;

    // Bind Slide Item Click & Keyboard Selection
    pane.querySelectorAll('.slide-nav-item').forEach((item) => {
      const slideId = (item as HTMLElement).dataset.slideId;
      if (!slideId) return;

      item.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        this.store.setSelection({ type: 'slide', slideId });
      });

      item.addEventListener('keydown', (e) => {
        const ke = e as KeyboardEvent;
        if (ke.key === 'Enter' || ke.key === ' ') {
          ke.preventDefault();
          this.store.setSelection({ type: 'slide', slideId });
        }
      });
    });

    pane.querySelectorAll('.btn-move-up').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = (btn as HTMLElement).dataset.id;
        if (id) this.store.moveSlide(id, 'up');
      });
    });

    pane.querySelectorAll('.btn-move-down').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = (btn as HTMLElement).dataset.id;
        if (id) this.store.moveSlide(id, 'down');
      });
    });

    pane.querySelectorAll('.btn-delete-slide').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = (btn as HTMLElement).dataset.id;
        if (id) this.store.deleteSlide(id);
      });
    });

    // Bind Filmstrip Bridge Click, Double-Click (file picker), and Drag & Drop
    pane.querySelectorAll('.filmstrip-bridge').forEach((bridge) => {
      const slideId = (bridge as HTMLElement).dataset.transitionSlideId;
      if (!slideId) return;

      bridge.addEventListener('click', () => {
        this.store.setSelection({ type: 'transition', slideId });
      });

      bridge.addEventListener('dblclick', () => {
        const input = this.root.querySelector('#single-video-input') as HTMLInputElement;
        input.dataset.targetSlideId = slideId;
        input.click();
      });

      bridge.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pill = bridge.querySelector('.filmstrip-pill') as HTMLElement;
        if (pill) pill.style.borderColor = '#0a84ff';
      });

      bridge.addEventListener('dragleave', () => {
        const pill = bridge.querySelector('.filmstrip-pill') as HTMLElement;
        if (pill) pill.style.borderColor = '';
      });

      bridge.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pill = bridge.querySelector('.filmstrip-pill') as HTMLElement;
        if (pill) pill.style.borderColor = '';
        const dt = (e as DragEvent).dataTransfer;
        if (!dt?.files?.length) return;
        await this.attachVideoFileToSlide(slideId, dt.files[0]);
      });
    });
  }

  /* =========================================================================
   * 3. CENTER STAGE: EMPTY STATE & FLOATING LIQUID GLASS HUD
   * ========================================================================= */
  private renderEmptyOverlay(): void {
    const overlay = this.root.querySelector('#empty-overlay') as HTMLElement;
    const hud = this.root.querySelector('#floating-stage-hud') as HTMLElement;
    if (!overlay) return;

    const slides = this.store.getSlides();
    if (slides.length > 0) {
      overlay.style.display = 'none';
      if (hud) hud.style.display = 'flex';
      return;
    }

    overlay.style.display = 'flex';
    if (hud) hud.style.display = 'none';

    overlay.innerHTML = `
      <div class="empty-sheet-card" id="empty-drop-card">
        <div class="empty-symbol-circle">${Icons.filmTransition}</div>
        <h2 class="empty-heading">أضف شرائح العرض وفيديوهات الانتقال</h2>
        <p class="empty-copy">
          اسحب صور الشرائح وفيديوهات الانتقال الحركية وأفلتها هنا لترتيبها تلقائياً، أو ابدأ بعرض تجريبي جاهز لمعاينة انتقالات الفيديو بدون أي تقطيع.
        </p>
        <div class="empty-meta-line">PNG · JPG · WEBP · MP4 · WEBM · MOV</div>
        <div class="empty-actions-row">
          <button class="btn btn-prominent" id="btn-empty-import">
            ${Icons.folderImport}
            <span>اختيار ملفات...</span>
          </button>
          <button class="btn" id="btn-empty-demo">
            ${Icons.sparkles}
            <span>توليد عرض تجريبي</span>
          </button>
        </div>
      </div>
    `;

    overlay.querySelector('#btn-empty-import')?.addEventListener('click', () => {
      this.handleImportMedia();
    });

    overlay.querySelector('#btn-empty-demo')?.addEventListener('click', () => {
      this.handleGenerateDemo();
    });
  }

  private ensureFloatingStageHudStructure(): void {
    const hud = this.root.querySelector('#floating-stage-hud') as HTMLElement;
    if (!hud || hud.querySelector('#btn-hud-next')) return;

    hud.innerHTML = `
      <button
        class="hud-transport-btn"
        id="btn-hud-prev"
        title="الشريحة السابقة (السهم الأيمن)"
        aria-label="الشريحة السابقة"
      >
        ${Icons.chevronRight}
      </button>

      <div class="hud-status-readout">
        <span class="hud-phase-dot" id="hud-phase-dot"></span>
        <span class="tabular-nums" id="hud-slide-counter" style="color: var(--label-primary); font-weight: 600;">
          01 / 01
        </span>
      </div>

      <button
        class="hud-step-btn"
        id="btn-hud-next"
        title="تشغيل الانتقال للشريحة التالية (Space أو السهم الأيسر)"
        aria-label="تشغيل الانتقال للشريحة التالية"
      >
        <span id="hud-next-label">التالي</span>
        ${Icons.chevronLeft}
      </button>

      <div class="toolbar-divider"></div>

      <button
        class="hud-transport-btn"
        id="btn-hud-replay"
        title="إعادة معاينة الانتقال الحالي"
        aria-label="إعادة معاينة الانتقال الحالي"
      >
        ${Icons.replay}
      </button>
    `;

    hud.querySelector('#btn-hud-prev')?.addEventListener('click', () => {
      this.previewEngine.previous();
    });

    hud.querySelector('#btn-hud-next')?.addEventListener('click', () => {
      this.previewEngine.next();
    });

    hud.querySelector('#btn-hud-replay')?.addEventListener('click', () => {
      this.previewEngine.previewCurrentTransition();
    });
  }

  private renderFloatingStageHud(): void {
    const hud = this.root.querySelector('#floating-stage-hud') as HTMLElement;
    if (!hud) return;

    const slides = this.store.getSlides();
    if (slides.length === 0) {
      hud.style.display = 'none';
      return;
    }
    hud.style.display = 'flex';

    this.ensureFloatingStageHudStructure();

    const status = this.latestEngineStatus;
    const idx = status?.currentSlideIndex ?? 0;
    const isTransitioning = status?.phase === 'PLAYING_TRANSITION';
    const currentFormatted = String(idx + 1).padStart(2, '0');
    const totalFormatted = String(slides.length).padStart(2, '0');

    const counter = hud.querySelector('#hud-slide-counter');
    if (counter && counter.textContent !== `${currentFormatted} / ${totalFormatted}`) {
      counter.textContent = `${currentFormatted} / ${totalFormatted}`;
    }

    const dot = hud.querySelector('#hud-phase-dot');
    dot?.classList.toggle('transitioning', isTransitioning);

    const nextLabel = hud.querySelector('#hud-next-label');
    const expectedNextText = isTransitioning ? 'تخطي' : 'التالي';
    if (nextLabel && nextLabel.textContent !== expectedNextText) {
      nextLabel.textContent = expectedNextText;
    }

    const prevBtn = hud.querySelector('#btn-hud-prev') as HTMLButtonElement;
    if (prevBtn) {
      prevBtn.disabled = idx === 0 && !this.store.getSettings().loopPresentation;
    }

    const replayBtn = hud.querySelector('#btn-hud-replay') as HTMLButtonElement;
    if (replayBtn) {
      replayBtn.disabled = slides.length < 2;
    }

    this.syncNavigatorActiveSlide(idx);
  }

  private syncNavigatorActiveSlide(currentIdx: number): void {
    const items = this.root.querySelectorAll('.slide-nav-item');
    items.forEach((item, i) => {
      const isCurrent = i === currentIdx;
      item.classList.toggle('selected', isCurrent);
      const gutter = item.querySelector('.slide-gutter-col');
      const existingDot = gutter?.querySelector('.live-stage-dot');
      if (isCurrent) {
        if (!existingDot && gutter) {
          const dot = document.createElement('span');
          dot.className = 'live-stage-dot';
          dot.title = 'معروضة حالياً';
          gutter.appendChild(dot);
        }
        item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else {
        if (existingDot) {
          existingDot.remove();
        }
      }
    });

    if (this.isPresentingFullscreen) {
      const notesContent = this.root.querySelector('#fs-notes-content');
      if (notesContent) {
        const slide = this.store.getSlides()[currentIdx];
        const notes = slide?.notes?.trim();
        notesContent.innerHTML = notes
          ? `<div class="presenter-notes-text">${this.escapeHtml(notes).replace(/\n/g, '<br/>')}</div>`
          : `<div class="presenter-notes-empty">لا توجد ملاحظات مسجلة لهذه الشريحة</div>`;
      }
    }
  }

  /* =========================================================================
   * 4. TRAILING PANE: INSPECTOR WITH MACOS SEGMENTED CONTROL
   * ========================================================================= */
  private renderInspectorPane(): void {
    const pane = this.root.querySelector('#inspector-pane') as HTMLElement;
    if (!pane) return;

    pane.classList.toggle('collapsed', !this.isInspectorVisible);

    const selection = this.store.getSelection();
    const slides = this.store.getSlides();
    const settings = this.store.getSettings();

    const activeSlide =
      selection.type === 'slide' || selection.type === 'transition'
        ? slides.find((s) => s.id === selection.slideId) || slides[0]
        : slides[this.store.getActivePreviewIndex()] || slides[0];

    const activeSegment =
      !activeSlide
        ? 'settings'
        : selection.type === 'slide'
          ? 'slide'
          : selection.type === 'transition'
            ? 'transition'
            : 'settings';

    let contentHtml = '';

    if (activeSegment === 'slide' && activeSlide) {
      const slideIdx = slides.findIndex((s) => s.id === activeSlide.id);
      contentHtml = `
        <div class="inspector-group">
          <div class="inspector-group-title">
            <span>الشريحة ${slideIdx + 1}</span>
            <span class="tabular-nums">${activeSlide.imageAsset.width}×${activeSlide.imageAsset.height}</span>
          </div>

          <div class="prop-row">
            <label class="prop-label" for="insp-slide-title">العنوان</label>
            <input
              type="text"
              class="input-field"
              id="insp-slide-title"
              value="${this.escapeHtml(activeSlide.title)}"
            />
          </div>

          <div class="prop-row">
            <span class="prop-label">ملف الصورة</span>
            <div class="prop-subtext" style="word-break: break-all;">
              ${this.escapeHtml(activeSlide.imageAsset.name)} (${(activeSlide.imageAsset.fileSize / 1024).toFixed(0)} KB)
            </div>
            <button class="btn" id="btn-replace-slide-img" style="margin-top: 4px; width: 100%;">
              استبدال صورة الشريحة...
            </button>
          </div>
        </div>

        <div class="inspector-group">
          <div class="inspector-group-title">
            <span>التوقيت والملاحظات</span>
          </div>

          <div class="prop-row">
            <label class="prop-label" for="insp-slide-hold">
              <span>الانتقال التلقائي (ثانية)</span>
              <span class="tabular-nums" style="color: var(--label-secondary);">
                ${activeSlide.holdDurationSec ? `${activeSlide.holdDurationSec}s` : 'يدوي'}
              </span>
            </label>
            <input
              type="number"
              min="0"
              max="300"
              step="0.5"
              class="input-field tabular-nums"
              id="insp-slide-hold"
              placeholder="0 (انتظار ضغطة المحاضر)"
              value="${activeSlide.holdDurationSec ?? ''}"
            />
            <span class="prop-subtext">اتركه فارغاً للتوقف على الشريحة حتى تضغط المسافة أو الماوس.</span>
          </div>

          <div class="prop-row">
            <label class="prop-label" for="insp-slide-notes">ملاحظات المحاضر</label>
            <textarea
              class="textarea-field"
              id="insp-slide-notes"
              rows="3"
              placeholder="ملاحظات خاصة بهذه الشريحة..."
            >${this.escapeHtml(activeSlide.notes)}</textarea>
          </div>
        </div>

        <div class="inspector-group" style="border-bottom: none;">
          <button class="btn btn-destructive" id="btn-insp-delete-slide" style="width: 100%;">
            ${Icons.trash}
            <span>حذف هذه الشريحة</span>
          </button>
        </div>
      `;
    } else if (activeSegment === 'transition' && activeSlide) {
      const slideIdx = slides.findIndex((s) => s.id === activeSlide.id);
      const spec = activeSlide.transitionToNext;
      const vid = spec.videoAsset;

      contentHtml = `
        <div class="inspector-group">
          <div class="inspector-group-title">
            <span>فيديو الانتقال (${slideIdx + 1} ← ${slideIdx + 2})</span>
            ${vid ? `<span class="tabular-nums" style="color: var(--signal-film);">${vid.durationSec.toFixed(2)}s</span>` : ''}
          </div>

          ${
            vid
              ? `
            <div class="inspector-filmstrip-box">
              <div class="inspector-frame-pair">
                <div class="inspector-frame-cell">
                  <img src="${vid.thumbnailUrl}" alt="الفريم الأول" />
                  <span>بداية الفيديو</span>
                </div>
                <div style="text-align: center; color: var(--label-secondary);">${Icons.arrowLeft}</div>
                <div class="inspector-frame-cell">
                  <img src="${vid.lastFrameUrl || vid.thumbnailUrl}" alt="الفريم الأخير" />
                  <span>نهاية الفيديو</span>
                </div>
              </div>
              <div class="prop-subtext" style="word-break: break-all;">
                ${this.escapeHtml(vid.name)} (${vid.width}×${vid.height})
              </div>
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px;">
              <button class="btn" id="btn-replace-trans-video">استبدال الفيديو...</button>
              <button class="btn btn-destructive" id="btn-remove-trans-video">إزالة الفيديو</button>
            </div>

            <button class="btn" id="btn-extract-end-frame" style="width: 100%;" title="يستخرج آخر إطار من الفيديو كصورة شريحة تالية">
              ${Icons.extractFrame}
              <span>استخراج آخر إطار كشريحة تالية</span>
            </button>
          `
              : `
            <div class="prop-subtext">
              لا يوجد ملف فيديو مخصص لهذا الانتقال. أرفق فيديو Motion Graphics ليتم تشغيله عند الانتقال للشريحة التالية.
            </div>
            <button class="btn btn-prominent" id="btn-replace-trans-video" style="width: 100%;">
              ${Icons.filmTransition}
              <span>ربط ملف فيديو انتقال...</span>
            </button>
          `
          }
        </div>

        <div class="inspector-group" style="border-bottom: none;">
          <div class="inspector-group-title">
            <span>السرعة والانتقال البديل</span>
          </div>

          <div class="prop-row">
            <label class="prop-label" for="insp-trans-speed">
              <span>سرعة التشغيل</span>
              <span class="tabular-nums" id="lbl-trans-speed">${spec.playbackSpeed.toFixed(2)}×</span>
            </label>
            <div class="slider-control-row">
              <input
                type="range"
                id="insp-trans-speed"
                min="0.25"
                max="2.5"
                step="0.05"
                value="${spec.playbackSpeed}"
              />
            </div>
          </div>

          <div class="prop-row-inline">
            <label class="prop-label" for="insp-trans-muted" style="cursor: pointer;">كتم صوت هذا الانتقال</label>
            <input type="checkbox" id="insp-trans-muted" ${spec.muted ? 'checked' : ''} />
          </div>

          <div class="prop-row">
            <label class="prop-label" for="insp-fallback-style">الانتقال البديل (بدون فيديو)</label>
            <select class="select-field" id="insp-fallback-style">
              <option value="crossfade" ${spec.fallbackStyle === 'crossfade' ? 'selected' : ''}>تلاشي ناعم (Crossfade)</option>
              <option value="zoom-morph" ${spec.fallbackStyle === 'zoom-morph' ? 'selected' : ''}>تقريب حركي (Zoom Morph)</option>
              <option value="slide-push" ${spec.fallbackStyle === 'slide-push' ? 'selected' : ''}>إزاحة جانبية (Slide Push)</option>
              <option value="cut" ${spec.fallbackStyle === 'cut' ? 'selected' : ''}>قطع مباشر (Cut)</option>
            </select>
          </div>
        </div>
      `;
    } else {
      contentHtml = `
        <div class="inspector-group">
          <div class="inspector-group-title">
            <span>سلوك التشغيل والتحكم</span>
          </div>

          <div class="prop-row">
            <label class="prop-label" for="set-interrupt-behavior">الضغط أثناء تشغيل فيديو الانتقال</label>
            <select class="select-field" id="set-interrupt-behavior">
              <option value="skip" ${settings.interruptBehavior === 'skip' ? 'selected' : ''}>تخطي فوري للشريحة التالية</option>
              <option value="lock" ${settings.interruptBehavior === 'lock' ? 'selected' : ''}>قفل الضغطة لحين انتهاء الفيديو</option>
              <option value="fast-forward" ${settings.interruptBehavior === 'fast-forward' ? 'selected' : ''}>تسريع الفيديو (3×)</option>
            </select>
          </div>

          <div class="prop-row">
            <label class="prop-label" for="set-backward-behavior">سلوك الرجوع للشريحة السابقة</label>
            <select class="select-field" id="set-backward-behavior">
              <option value="reverse-step" ${settings.backwardBehavior === 'reverse-step' ? 'selected' : ''}>حركة عكسية متطابقة (عكس حركة الشريحة)</option>
              <option value="crossfade" ${settings.backwardBehavior === 'crossfade' ? 'selected' : ''}>تلاشي ناعم (Crossfade)</option>
              <option value="instant" ${settings.backwardBehavior === 'instant' ? 'selected' : ''}>انتقال فوري (بدون حركة)</option>
            </select>
          </div>

          <div class="prop-row">
            <label class="prop-label" for="set-global-speed">
              <span>السرعة العامة</span>
              <span class="tabular-nums" id="lbl-global-speed">${settings.globalPlaybackSpeed.toFixed(2)}×</span>
            </label>
            <div class="slider-control-row">
              <input
                type="range"
                id="set-global-speed"
                min="0.5"
                max="2.0"
                step="0.05"
                value="${settings.globalPlaybackSpeed}"
              />
            </div>
          </div>

          <div class="prop-row-inline">
            <label class="prop-label" for="set-loop" style="cursor: pointer;">تكرار العرض تلقائياً (Loop)</label>
            <input type="checkbox" id="set-loop" ${settings.loopPresentation ? 'checked' : ''} />
          </div>
        </div>

        <div class="inspector-group" style="border-bottom: none;">
          <div class="inspector-group-title">
            <span>الشاشة والصوت</span>
          </div>

          <div class="prop-row">
            <label class="prop-label" for="set-aspect-ratio">نسبة الأبعاد</label>
            <select class="select-field" id="set-aspect-ratio">
              <option value="16:9" ${settings.aspectRatio === '16:9' ? 'selected' : ''}>16:9 (شاشة عريضة قياسية)</option>
              <option value="16:10" ${settings.aspectRatio === '16:10' ? 'selected' : ''}>16:10 (شاشات العرض المحمولة)</option>
              <option value="4:3" ${settings.aspectRatio === '4:3' ? 'selected' : ''}>4:3 (قياسي)</option>
              <option value="9:16" ${settings.aspectRatio === '9:16' ? 'selected' : ''}>9:16 (طولي)</option>
            </select>
          </div>

          <div class="prop-row">
            <label class="prop-label" for="set-fit-mode">مطابقة أبعاد المحتوى</label>
            <select class="select-field" id="set-fit-mode">
              <option value="contain" ${settings.fitMode === 'contain' ? 'selected' : ''}>احتواء كامل (Contain)</option>
              <option value="cover" ${settings.fitMode === 'cover' ? 'selected' : ''}>ملء الشاشة (Cover)</option>
            </select>
          </div>

          <div class="prop-row">
            <label class="prop-label" for="set-hud">عناصر التحكم في وضع ملء الشاشة</label>
            <select class="select-field" id="set-hud">
              <option value="minimal" ${settings.showPresenterHud === 'minimal' ? 'selected' : ''}>شريط عائم يختفي تلقائياً</option>
              <option value="progress-bar" ${settings.showPresenterHud === 'progress-bar' ? 'selected' : ''}>شريط تقدم علوي فقط</option>
              <option value="hidden" ${settings.showPresenterHud === 'hidden' ? 'selected' : ''}>مخفي تماماً</option>
            </select>
          </div>

          <div class="prop-row">
            <label class="prop-label" for="set-master-volume">
              <span>مستوى الصوت العام</span>
              <span class="tabular-nums" id="lbl-master-volume">${Math.round((settings.masterVolume ?? 0.9) * 100)}%</span>
            </label>
            <div class="slider-control-row">
              <input
                type="range"
                id="set-master-volume"
                min="0"
                max="1"
                step="0.05"
                value="${settings.masterVolume ?? 0.9}"
              />
            </div>
          </div>

          <div class="prop-row-inline">
            <label class="prop-label" for="set-master-muted" style="cursor: pointer;">كتم الصوت العام</label>
            <input type="checkbox" id="set-master-muted" ${settings.masterMuted ? 'checked' : ''} />
          </div>

          <div class="prop-row">
            <label class="prop-label" for="set-stage-bg">لون خلفية المنصة</label>
            <div style="display: flex; gap: 8px; align-items: center;">
              <input type="color" id="set-stage-bg" value="${settings.stageBackground || '#05070B'}" style="width: 38px; height: 28px; padding: 0; border: none; background: transparent; cursor: pointer;" />
              <input type="text" id="set-stage-bg-text" class="input-field tabular-nums" value="${settings.stageBackground || '#05070B'}" style="flex: 1;" />
            </div>
          </div>

          <div class="prop-row">
            <label class="prop-label" for="set-preload-strategy">استراتيجية التحميل المسبق</label>
            <select class="select-field" id="set-preload-strategy">
              <option value="all" ${settings.preloadStrategy === 'all' ? 'selected' : ''}>تحميل مسبق لكافة الوسائط (أسرع استجابة)</option>
              <option value="adjacent" ${settings.preloadStrategy === 'adjacent' ? 'selected' : ''}>تحميل ذكي للشرائح المجاورة (استهلاك ذاكرة أقل)</option>
            </select>
          </div>

          <div class="prop-row-inline">
            <label class="prop-label" for="set-autohide-cursor" style="cursor: pointer;">إخفاء مؤشر الماوس تلقائياً في ملء الشاشة</label>
            <input type="checkbox" id="set-autohide-cursor" ${settings.autoHideCursor ? 'checked' : ''} />
          </div>

          <div class="prop-row">
            <label class="prop-label" for="set-default-fallback-style">الانتقال البديل الافتراضي</label>
            <select class="select-field" id="set-default-fallback-style">
              <option value="crossfade" ${settings.defaultFallbackStyle === 'crossfade' ? 'selected' : ''}>تلاشي ناعم (Crossfade)</option>
              <option value="zoom-morph" ${settings.defaultFallbackStyle === 'zoom-morph' ? 'selected' : ''}>تقريب حركي (Zoom Morph)</option>
              <option value="slide-push" ${settings.defaultFallbackStyle === 'slide-push' ? 'selected' : ''}>إزاحة جانبية (Slide Push)</option>
              <option value="cut" ${settings.defaultFallbackStyle === 'cut' ? 'selected' : ''}>قطع مباشر (Cut)</option>
            </select>
          </div>

          <div class="prop-row">
            <label class="prop-label" for="set-default-fallback-dur">مدة الانتقال البديل (مللي ثانية)</label>
            <input type="number" id="set-default-fallback-dur" class="input-field tabular-nums" min="100" max="3000" step="50" value="${settings.defaultFallbackDurationMs}" />
          </div>
        </div>
      `;
    }

    // Equal-width noun-only Segmented Control per segmented-controls.md › Content
    pane.innerHTML = `
      <div class="segmented-control-wrap">
        <div class="segmented-control" role="tablist" aria-label="أقسام الخصائص">
          <button
            class="segment-btn ${activeSegment === 'slide' ? 'active' : ''}"
            data-tab="slide"
            role="tab"
            aria-selected="${activeSegment === 'slide'}"
            ${!activeSlide ? 'disabled' : ''}
          >
            الشريحة
          </button>
          <button
            class="segment-btn ${activeSegment === 'transition' ? 'active' : ''}"
            data-tab="transition"
            role="tab"
            aria-selected="${activeSegment === 'transition'}"
            ${!activeSlide ? 'disabled' : ''}
          >
            الانتقال
          </button>
          <button
            class="segment-btn ${activeSegment === 'settings' ? 'active' : ''}"
            data-tab="settings"
            role="tab"
            aria-selected="${activeSegment === 'settings'}"
          >
            العرض
          </button>
        </div>
      </div>
      <div class="inspector-scroll">
        ${contentHtml}
      </div>
    `;

    pane.querySelectorAll('.segment-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = (btn as HTMLElement).dataset.tab;
        if (tab === 'settings') {
          this.store.setSelection({ type: 'settings' });
        } else if (activeSlide && (tab === 'slide' || tab === 'transition')) {
          this.store.setSelection({ type: tab, slideId: activeSlide.id });
        }
      });
    });

    if (activeSegment === 'slide' && activeSlide) {
      const titleIn = pane.querySelector('#insp-slide-title') as HTMLInputElement;
      titleIn?.addEventListener('change', () => {
        this.store.updateSlideDetails(activeSlide.id, { title: titleIn.value });
      });

      const holdIn = pane.querySelector('#insp-slide-hold') as HTMLInputElement;
      holdIn?.addEventListener('change', () => {
        const val = parseFloat(holdIn.value);
        this.store.updateSlideDetails(activeSlide.id, {
          holdDurationSec: Number.isFinite(val) && val > 0 ? val : null,
        });
      });

      const notesIn = pane.querySelector('#insp-slide-notes') as HTMLTextAreaElement;
      notesIn?.addEventListener('change', () => {
        this.store.updateSlideDetails(activeSlide.id, { notes: notesIn.value });
      });

      pane.querySelector('#btn-replace-slide-img')?.addEventListener('click', () => {
        const input = this.root.querySelector('#single-image-input') as HTMLInputElement;
        input.dataset.replaceSlideId = activeSlide.id;
        input.click();
      });

      pane.querySelector('#btn-insp-delete-slide')?.addEventListener('click', () => {
        this.store.deleteSlide(activeSlide.id);
      });
    }

    if (activeSegment === 'transition' && activeSlide) {
      pane.querySelector('#btn-replace-trans-video')?.addEventListener('click', () => {
        const input = this.root.querySelector('#single-video-input') as HTMLInputElement;
        input.dataset.targetSlideId = activeSlide.id;
        input.click();
      });

      pane.querySelector('#btn-remove-trans-video')?.addEventListener('click', () => {
        this.store.setSlideTransitionVideo(activeSlide.id, null);
        this.store.notify('تمت إزالة فيديو الانتقال', 'info');
      });

      pane.querySelector('#btn-extract-end-frame')?.addEventListener('click', () => {
        this.store.extractNextSlideFromTransitionEnd(activeSlide.id);
      });

      const speedInput = pane.querySelector('#insp-trans-speed') as HTMLInputElement;
      const speedLbl = pane.querySelector('#lbl-trans-speed') as HTMLElement;
      speedInput?.addEventListener('input', () => {
        const v = parseFloat(speedInput.value) || 1.0;
        if (speedLbl) speedLbl.textContent = `${v.toFixed(2)}×`;
      });
      speedInput?.addEventListener('change', () => {
        const v = parseFloat(speedInput.value) || 1.0;
        this.store.updateTransitionSpec(activeSlide.id, { playbackSpeed: v });
      });

      const mutedCheck = pane.querySelector('#insp-trans-muted') as HTMLInputElement;
      mutedCheck?.addEventListener('change', () => {
        this.store.updateTransitionSpec(activeSlide.id, { muted: mutedCheck.checked });
      });

      const fallbackSelect = pane.querySelector('#insp-fallback-style') as HTMLSelectElement;
      fallbackSelect?.addEventListener('change', () => {
        this.store.updateTransitionSpec(activeSlide.id, {
          fallbackStyle: fallbackSelect.value as FallbackTransitionStyle,
        });
      });
    }

    if (activeSegment === 'settings') {
      const interruptSel = pane.querySelector('#set-interrupt-behavior') as HTMLSelectElement;
      interruptSel?.addEventListener('change', () => {
        this.store.updateSettings({
          interruptBehavior: interruptSel.value as InterruptBehavior,
        });
      });

      const backSel = pane.querySelector('#set-backward-behavior') as HTMLSelectElement;
      backSel?.addEventListener('change', () => {
        this.store.updateSettings({
          backwardBehavior: backSel.value as BackwardBehavior,
        });
      });

      const globalSpeedIn = pane.querySelector('#set-global-speed') as HTMLInputElement;
      const globalSpeedLbl = pane.querySelector('#lbl-global-speed') as HTMLElement;
      globalSpeedIn?.addEventListener('input', () => {
        const v = parseFloat(globalSpeedIn.value) || 1.0;
        if (globalSpeedLbl) globalSpeedLbl.textContent = `${v.toFixed(2)}×`;
      });
      globalSpeedIn?.addEventListener('change', () => {
        const v = parseFloat(globalSpeedIn.value) || 1.0;
        this.store.updateSettings({ globalPlaybackSpeed: v });
      });

      const loopCheck = pane.querySelector('#set-loop') as HTMLInputElement;
      loopCheck?.addEventListener('change', () => {
        this.store.updateSettings({ loopPresentation: loopCheck.checked });
      });

      const ratioSel = pane.querySelector('#set-aspect-ratio') as HTMLSelectElement;
      ratioSel?.addEventListener('change', () => {
        this.store.updateSettings({ aspectRatio: ratioSel.value as AspectRatioOption });
      });

      const fitSel = pane.querySelector('#set-fit-mode') as HTMLSelectElement;
      fitSel?.addEventListener('change', () => {
        this.store.updateSettings({ fitMode: fitSel.value as FitMode });
      });

      const hudSel = pane.querySelector('#set-hud') as HTMLSelectElement;
      hudSel?.addEventListener('change', () => {
        this.store.updateSettings({ showPresenterHud: hudSel.value as HudVisibility });
      });

      const muteCheck = pane.querySelector('#set-master-muted') as HTMLInputElement;
      muteCheck?.addEventListener('change', () => {
        this.store.updateSettings({ masterMuted: muteCheck.checked });
      });

      const volInput = pane.querySelector('#set-master-volume') as HTMLInputElement;
      const volLbl = pane.querySelector('#lbl-master-volume') as HTMLElement;
      volInput?.addEventListener('input', () => {
        const v = parseFloat(volInput.value) || 0.9;
        if (volLbl) volLbl.textContent = `${Math.round(v * 100)}%`;
      });
      volInput?.addEventListener('change', () => {
        const v = parseFloat(volInput.value) || 0.9;
        this.store.updateSettings({ masterVolume: v });
      });

      const stageBg = pane.querySelector('#set-stage-bg') as HTMLInputElement;
      const stageBgText = pane.querySelector('#set-stage-bg-text') as HTMLInputElement;
      stageBg?.addEventListener('input', () => {
        if (stageBgText) stageBgText.value = stageBg.value;
      });
      stageBg?.addEventListener('change', () => {
        this.store.updateSettings({ stageBackground: stageBg.value });
      });
      stageBgText?.addEventListener('change', () => {
        this.store.updateSettings({ stageBackground: stageBgText.value });
      });

      const preloadSel = pane.querySelector('#set-preload-strategy') as HTMLSelectElement;
      preloadSel?.addEventListener('change', () => {
        this.store.updateSettings({ preloadStrategy: preloadSel.value as 'all' | 'adjacent' });
      });

      const autoHideCheck = pane.querySelector('#set-autohide-cursor') as HTMLInputElement;
      autoHideCheck?.addEventListener('change', () => {
        this.store.updateSettings({ autoHideCursor: autoHideCheck.checked });
      });

      const fallbackSel = pane.querySelector('#set-default-fallback-style') as HTMLSelectElement;
      fallbackSel?.addEventListener('change', () => {
        this.store.updateSettings({ defaultFallbackStyle: fallbackSel.value as FallbackTransitionStyle });
      });

      const fallbackDurIn = pane.querySelector('#set-default-fallback-dur') as HTMLInputElement;
      fallbackDurIn?.addEventListener('change', () => {
        const d = parseInt(fallbackDurIn.value, 10) || 650;
        this.store.updateSettings({ defaultFallbackDurationMs: d });
      });
    }
  }

  private renderToast(): void {
    const container = this.root.querySelector('#toast-container') as HTMLElement;
    if (!container) return;

    const note = this.store.getNotification();
    if (!note) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = `
      <div class="status-toast ${note.kind}">
        <span class="status-toast-dot"></span>
        <span>${this.escapeHtml(note.message)}</span>
      </div>
    `;
  }

  private setupHiddenFileInputs(): void {
    const batchInput = this.root.querySelector('#batch-file-input') as HTMLInputElement;
    batchInput?.addEventListener('change', async () => {
      if (!batchInput.files?.length) return;
      await this.handleBatchFiles(Array.from(batchInput.files));
      batchInput.value = '';
    });

    const projectInput = this.root.querySelector('#project-file-input') as HTMLInputElement;
    projectInput?.addEventListener('change', async () => {
      if (!projectInput.files?.length) return;
      const file = projectInput.files[0];
      projectInput.value = '';
      try {
        const text = await file.text();
        const project = ProjectSerializer.deserializeProject(text);
        this.store.loadProjectFromManifest(project);
        this.store.notify(`تم فتح المشروع (${project.title}) بنجاح`, 'success');
      } catch (err) {
        this.store.notify(
          err instanceof Error ? err.message : 'تعذر قراءة ملف المشروع',
          'error'
        );
      }
    });

    const singleImgInput = this.root.querySelector('#single-image-input') as HTMLInputElement;
    singleImgInput?.addEventListener('change', async () => {
      if (!singleImgInput.files?.length) return;
      const file = singleImgInput.files[0];
      const replaceId = singleImgInput.dataset.replaceSlideId;
      singleImgInput.value = '';

      try {
        const asset = await MediaValidator.ingestFile(file, 'image');
        if (replaceId) {
          this.store.replaceSlideImage(replaceId, asset);
          this.store.notify(`تم تحديث صورة الشريحة (${asset.name})`, 'success');
        } else {
          this.store.addSlideFromImage(asset);
          this.store.notify(`تمت إضافة الشريحة (${asset.name})`, 'success');
        }
      } catch (err) {
        this.store.notify(
          err instanceof Error ? err.message : 'ملف الصورة غير صالح',
          'error'
        );
      }
    });

    const singleVidInput = this.root.querySelector('#single-video-input') as HTMLInputElement;
    singleVidInput?.addEventListener('change', async () => {
      if (!singleVidInput.files?.length) return;
      const file = singleVidInput.files[0];
      const targetSlideId = singleVidInput.dataset.targetSlideId;
      singleVidInput.value = '';
      if (!targetSlideId) return;
      await this.attachVideoFileToSlide(targetSlideId, file);
    });
  }

  private async attachVideoFileToSlide(slideId: string, file: File): Promise<void> {
    try {
      this.store.notify(`جاري تحليل الفيديو (${file.name})...`, 'info', 2000);
      const videoAsset = await MediaValidator.ingestFile(file, 'video');
      this.store.setSlideTransitionVideo(slideId, videoAsset);
      this.store.notify(
        `تم ربط فيديو الانتقال (${videoAsset.name} · ${videoAsset.durationSec.toFixed(1)}s)`,
        'success'
      );
    } catch (err) {
      this.store.notify(
        err instanceof Error ? err.message : 'ملف الفيديو غير مدعوم',
        'error'
      );
    }
  }

  private setupGlobalDragAndDrop(): void {
    const stagePane = this.root.querySelector('#stage-pane') as HTMLElement;

    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.root.querySelector('#empty-drop-card')?.classList.add('drag-over');
    });

    window.addEventListener('dragleave', () => {
      this.root.querySelector('#empty-drop-card')?.classList.remove('drag-over');
    });

    window.addEventListener('drop', (e) => {
      e.preventDefault();
      this.root.querySelector('#empty-drop-card')?.classList.remove('drag-over');
    });

    stagePane?.addEventListener('drop', async (e) => {
      e.preventDefault();
      this.root.querySelector('#empty-drop-card')?.classList.remove('drag-over');
      if (!e.dataTransfer?.files?.length) return;
      await this.handleBatchFiles(Array.from(e.dataTransfer.files));
    });
  }

  private async handleBatchFiles(files: File[]): Promise<void> {
    this.store.notify(`جاري فرز ${files.length} ملف...`, 'info', 2500);
    const { newSlides, unpairedVideos, report } = await SmartPairer.processBatchFiles(
      files,
      this.store.getSlides().length,
      this.store.getSettings().defaultFallbackStyle
    );

    if (newSlides.length > 0 || unpairedVideos.length > 0) {
      this.store.appendBatchSlides(newSlides, unpairedVideos);
    }

    if (report.rejectedFiles.length > 0) {
      const firstErr = report.rejectedFiles[0];
      this.store.notify(
        `تم استيراد ${report.slidesAdded} شريحة، واستبعاد ${report.rejectedFiles.length} ملف (${firstErr.name})`,
        'warning',
        5000
      );
    } else {
      this.store.notify(
        `تم استيراد ${report.slidesAdded} شرائح وربط ${report.transitionsMatched} فيديوهات انتقال`,
        'success'
      );
    }
  }

  private async handleGenerateDemo(): Promise<void> {
    if (this.isGeneratingDemo) return;
    this.isGeneratingDemo = true;
    this.renderWindowToolbar();

    try {
      const demoSlides = await DemoGenerator.generateDemoSlides((msg) => {
        this.store.notify(msg, 'info', 2000);
      });
      this.store.batchUpdate(() => {
        this.store.clearAllSlides();
        this.store.setProjectTitle('عرض تجريبي — Motion Studio');
        this.store.appendBatchSlides(demoSlides);
      });
      this.store.notify(
        'تم تجهيز العرض التجريبي (4 شرائح مع فيديوهات انتقال حركية)',
        'success',
        4500
      );
    } catch (err) {
      this.store.notify(
        err instanceof Error ? err.message : 'تعذر إنشاء العرض التجريبي',
        'error'
      );
    } finally {
      this.isGeneratingDemo = false;
      this.renderWindowToolbar();
    }
  }

  /* =========================================================================
   * 5. FULLSCREEN PRESENTATION MODE (F5)
   * ========================================================================= */
  private async enterFullscreenPresentation(startIndex = 0): Promise<void> {
    const slides = this.store.getSlides();
    if (slides.length === 0 || this.isPresentingFullscreen) return;

    // Pause studio preview engine to avoid dual hardware decoding and resource contention
    this.previewEngine.pause();

    this.isPresentingFullscreen = true;
    this.isSlideGridOpen = false;

    const fsRoot = this.root.querySelector('#fullscreen-root') as HTMLElement;
    const settings = this.store.getSettings();

    fsRoot.innerHTML = `
      <div class="fullscreen-presenter" id="fs-presenter">
        <div class="presenter-top-progress" id="fs-top-progress" style="${settings.showPresenterHud === 'hidden' ? 'display:none;' : ''}">
          <div class="presenter-top-progress-bar" id="fs-top-bar" style="width:0%"></div>
        </div>
        <canvas class="presenter-canvas" id="fs-canvas"></canvas>
        <div class="presenter-hud" id="fs-hud" style="${settings.showPresenterHud !== 'minimal' ? 'display:none;' : ''}">
          <button class="hud-transport-btn" id="fs-btn-prev" title="السابق" aria-label="الشريحة السابقة">
            ${Icons.chevronRight}
          </button>
          <span id="fs-hud-label" class="tabular-nums" style="font-weight:600; min-width:86px; text-align:center;"></span>
          <button class="hud-step-btn" id="fs-btn-next" title="التالي" aria-label="الشريحة التالية">
            <span>التالي</span>
            ${Icons.chevronLeft}
          </button>
          <div class="toolbar-divider"></div>
          <button class="hud-transport-btn" id="fs-btn-notes" title="ملاحظات المتحدث (N)" aria-label="ملاحظات المتحدث">
            ${Icons.notes}
          </button>
          <button class="hud-transport-btn" id="fs-btn-grid" title="شبكة الشرائح (G)" aria-label="عرض شبكة الشرائح">
            ${Icons.grid}
          </button>
          <button class="hud-transport-btn" id="fs-btn-exit" title="إنهاء العرض (Esc)" aria-label="إنهاء العرض">
            ${Icons.close}
          </button>
        </div>
        <aside class="presenter-notes-drawer hidden" id="fs-notes-drawer" role="complementary" aria-label="ملاحظات المتحدث">
          <div class="presenter-notes-header">
            <div style="display:flex; align-items:center; gap:8px;">
              ${Icons.notes}
              <span style="font-weight:600; font-size:13px;">ملاحظات المتحدث</span>
            </div>
            <button class="icon-btn sm" id="fs-btn-close-notes" aria-label="إغلاق">${Icons.close}</button>
          </div>
          <div class="presenter-notes-body" id="fs-notes-content"></div>
        </aside>
        <div id="fs-grid-host"></div>
      </div>
    `;

    this.presenterOverlayEl = fsRoot.querySelector('#fs-presenter') as HTMLElement;
    const fsCanvas = fsRoot.querySelector('#fs-canvas') as HTMLCanvasElement;

    this.presenterEngine = new StagePlaybackEngine(fsCanvas, settings);
    this.presenterEngine.onStatusChange((st) => {
      this.updateFullscreenHud(st);
    });

    await this.presenterEngine.loadProject(slides, settings, startIndex);

    try {
      if (window.desktopAPI?.setFullScreen) {
        await window.desktopAPI.setFullScreen(true);
      } else if (this.presenterOverlayEl.requestFullscreen) {
        await this.presenterOverlayEl.requestFullscreen();
      }
    } catch {
      // Fallback to maximized overlay
    }

    fsCanvas.addEventListener('click', () => {
      if (!this.isSlideGridOpen) {
        this.presenterEngine?.next();
      }
    });

    fsCanvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!this.isSlideGridOpen) {
        this.presenterEngine?.previous();
      }
    });

    fsRoot.querySelector('#fs-btn-prev')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.presenterEngine?.previous();
    });

    fsRoot.querySelector('#fs-btn-next')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.presenterEngine?.next();
    });

    fsRoot.querySelector('#fs-btn-notes')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePresenterNotes();
    });

    fsRoot.querySelector('#fs-btn-close-notes')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePresenterNotes();
    });

    fsRoot.querySelector('#fs-btn-grid')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePresenterSlideGrid();
    });

    fsRoot.querySelector('#fs-btn-exit')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.exitFullscreenPresentation();
    });

    this.presenterOverlayEl.addEventListener('mousemove', () => {
      this.resetPresenterCursorAutoHide();
    });
    this.resetPresenterCursorAutoHide();
  }

  private togglePresenterNotes(): void {
    if (!this.isPresentingFullscreen) return;
    const drawer = this.root.querySelector('#fs-notes-drawer') as HTMLElement;
    if (!drawer) return;
    drawer.classList.toggle('hidden');
  }

  private updateFullscreenHud(status: EngineStatus): void {
    if (!this.isPresentingFullscreen) return;
    const slides = this.store.getSlides();
    const label = this.root.querySelector('#fs-hud-label') as HTMLElement;
    const topBar = this.root.querySelector('#fs-top-bar') as HTMLElement;
    const notesContent = this.root.querySelector('#fs-notes-content') as HTMLElement;

    const current = String(status.currentSlideIndex + 1).padStart(2, '0');
    const total = String(slides.length).padStart(2, '0');
    if (label) {
      if (status.phase === 'PLAYING_TRANSITION') {
        const target = String((status.targetSlideIndex ?? status.currentSlideIndex) + 1).padStart(2, '0');
        label.textContent = `${current} ← ${target}`;
      } else if (status.phase === 'BLACKOUT') {
        label.textContent = `إعتام (B)`;
      } else {
        label.textContent = `${current} / ${total}`;
      }
    }

    if (topBar && slides.length > 0) {
      const basePct =
        slides.length > 1
          ? ((status.currentSlideIndex +
              (status.phase === 'PLAYING_TRANSITION' ? status.transitionProgress : 0)) /
              (slides.length - 1)) *
            100
          : 100;
      topBar.style.width = `${Math.min(100, Math.max(0, basePct))}%`;
    }

    if (notesContent) {
      const currentSlide = slides[status.currentSlideIndex];
      const notes = currentSlide?.notes?.trim();
      notesContent.innerHTML = notes
        ? `<div class="presenter-notes-text">${this.escapeHtml(notes).replace(/\n/g, '<br/>')}</div>`
        : `<div class="presenter-notes-empty">لا توجد ملاحظات مسجلة لهذه الشريحة</div>`;
    }
  }

  private togglePresenterSlideGrid(): void {
    if (!this.isPresentingFullscreen) return;
    this.isSlideGridOpen = !this.isSlideGridOpen;
    const host = this.root.querySelector('#fs-grid-host') as HTMLElement;
    if (!host) return;

    if (!this.isSlideGridOpen) {
      host.innerHTML = '';
      return;
    }

    const slides = this.store.getSlides();
    const activeIdx = this.presenterEngine?.getStatus().currentSlideIndex ?? 0;

    host.innerHTML = `
      <div class="slide-grid-modal" role="dialog" aria-label="متصفح الشرائح السريع">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h2 style="font-size:17px; font-weight:600;">الانتقال السريع إلى شريحة</h2>
          <button class="btn" id="btn-close-grid">
            ${Icons.close}
            <span>إغلاق</span>
          </button>
        </div>
        <div class="grid-cards-container">
          ${slides
            .map(
              (s, i) => `
            <div class="grid-jump-card ${i === activeIdx ? 'active' : ''}" data-idx="${i}" tabindex="0" role="button">
              <img src="${s.imageAsset.thumbnailUrl || s.imageAsset.objectUrl}" alt="${this.escapeHtml(s.title)}" />
              <div class="grid-jump-card-title">
                <span class="tabular-nums" style="color:var(--label-secondary); margin-left:6px;">${i + 1}</span>
                <span>${this.escapeHtml(s.title)}</span>
              </div>
            </div>
          `
            )
            .join('')}
        </div>
      </div>
    `;

    host.querySelector('#btn-close-grid')?.addEventListener('click', () => {
      this.togglePresenterSlideGrid();
    });

    host.querySelectorAll('.grid-jump-card').forEach((card) => {
      card.addEventListener('click', () => {
        const idx = parseInt((card as HTMLElement).dataset.idx || '0', 10);
        this.togglePresenterSlideGrid();
        this.presenterEngine?.jumpToSlide(idx, true);
      });
    });
  }

  private resetPresenterCursorAutoHide(): void {
    if (!this.presenterOverlayEl) return;
    this.presenterOverlayEl.classList.remove('hide-cursor');
    if (this.presenterCursorTimer) {
      clearTimeout(this.presenterCursorTimer);
    }
    if (this.store.getSettings().autoHideCursor) {
      this.presenterCursorTimer = window.setTimeout(() => {
        if (this.isPresentingFullscreen && !this.isSlideGridOpen) {
          this.presenterOverlayEl?.classList.add('hide-cursor');
        }
      }, 2200);
    }
  }

  private async exitFullscreenPresentation(): Promise<void> {
    if (!this.isPresentingFullscreen) return;
    const lastIdx = this.presenterEngine?.getStatus().currentSlideIndex ?? 0;

    this.isPresentingFullscreen = false;
    this.isSlideGridOpen = false;
    if (this.presenterCursorTimer) {
      clearTimeout(this.presenterCursorTimer);
      this.presenterCursorTimer = null;
    }

    this.presenterEngine?.destroy();
    this.presenterEngine = null;
    this.presenterOverlayEl = null;

    const fsRoot = this.root.querySelector('#fullscreen-root') as HTMLElement;
    if (fsRoot) fsRoot.innerHTML = '';

    try {
      if (window.desktopAPI?.setFullScreen) {
        await window.desktopAPI.setFullScreen(false);
      } else if (document.fullscreenElement) {
        await document.exitFullscreen();
      }
    } catch {
      // Ignore
    }

    this.store.setActivePreviewIndex(lastIdx);
    await this.previewEngine.jumpToSlide(lastIdx, true);
  }

  /* =========================================================================
   * 6. KEYBOARD SHORTCUTS & NATIVE DESKTOP MENU COMMANDS (keyboards.md, the-menu-bar.md)
   * ========================================================================= */
  private bindNativeMenuCommands(): void {
    window.desktopAPI?.onMenuCommand?.((cmd) => {
      switch (cmd) {
        case 'import-media':
          this.handleImportMedia();
          break;
        case 'open-project':
          this.handleOpenProject();
          break;
        case 'add-slide': {
          const input = this.root.querySelector('#single-image-input') as HTMLInputElement;
          input.dataset.replaceSlideId = '';
          input.click();
          break;
        }
        case 'load-demo':
          this.handleGenerateDemo();
          break;
        case 'save-project':
          if (this.store.getSlides().length > 0) {
            ProjectSerializer.exportProjectManifest(this.store.getProject());
          }
          break;
        case 'toggle-navigator':
          this.toggleNavigatorPane();
          break;
        case 'toggle-inspector':
          this.toggleInspectorPane();
          break;
        case 'start-presentation':
          this.enterFullscreenPresentation(
            this.latestEngineStatus?.currentSlideIndex || 0
          );
          break;
      }
    });
  }

  private bindGlobalShortcuts(): void {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      const isInputFocused =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT');

      // Native style pane and action shortcuts
      if ((e.ctrlKey || e.metaKey) && e.key === '1') {
        e.preventDefault();
        this.toggleNavigatorPane();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault();
        this.toggleInspectorPane();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault();
        this.handleOpenProject();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (this.store.getSlides().length > 0) {
          ProjectSerializer.exportProjectManifest(this.store.getProject());
        }
        return;
      }

      if (e.key === 'F5') {
        e.preventDefault();
        if (!this.isPresentingFullscreen) {
          this.enterFullscreenPresentation(
            this.latestEngineStatus?.currentSlideIndex || 0
          );
        }
        return;
      }

      if (this.isPresentingFullscreen) {
        if (e.key === 'Escape') {
          e.preventDefault();
          if (this.isSlideGridOpen) {
            this.togglePresenterSlideGrid();
          } else {
            this.exitFullscreenPresentation();
          }
          return;
        }

        if (e.key.toLowerCase() === 'g') {
          e.preventDefault();
          this.togglePresenterSlideGrid();
          return;
        }

        if (e.key.toLowerCase() === 'n') {
          e.preventDefault();
          this.togglePresenterNotes();
          return;
        }

        if (e.key.toLowerCase() === 'b' || e.key === '.') {
          e.preventDefault();
          this.presenterEngine?.toggleBlackout();
          return;
        }

        // RTL orientation: Left is forward/next, Right is backward/prev
        if (
          e.key === ' ' ||
          e.key === 'ArrowLeft' ||
          e.key === 'ArrowDown' ||
          e.key === 'PageDown' ||
          e.key === 'Enter'
        ) {
          e.preventDefault();
          this.presenterEngine?.next();
          return;
        }

        if (
          e.key === 'ArrowRight' ||
          e.key === 'ArrowUp' ||
          e.key === 'PageUp' ||
          e.key === 'Backspace'
        ) {
          e.preventDefault();
          this.presenterEngine?.previous();
          return;
        }

        if (e.key === 'Home') {
          e.preventDefault();
          this.presenterEngine?.jumpToSlide(0, true);
          return;
        }

        if (e.key === 'End') {
          e.preventDefault();
          this.presenterEngine?.jumpToSlide(this.store.getSlides().length - 1, true);
          return;
        }
        return;
      }

      // Studio view shortcuts (when no text input/textarea is focused)
      if (!isInputFocused && this.store.getSlides().length > 0) {
        if (
          e.key === ' ' ||
          e.key === 'ArrowLeft' ||
          e.key === 'ArrowDown' ||
          e.key === 'PageDown'
        ) {
          e.preventDefault();
          this.previewEngine.next();
          return;
        }

        if (
          e.key === 'ArrowRight' ||
          e.key === 'ArrowUp' ||
          e.key === 'PageUp' ||
          e.key === 'Backspace'
        ) {
          e.preventDefault();
          this.previewEngine.previous();
          return;
        }

        if (e.key === 'Home') {
          e.preventDefault();
          this.previewEngine.jumpToSlide(0, true);
          return;
        }

        if (e.key === 'End') {
          e.preventDefault();
          this.previewEngine.jumpToSlide(this.store.getSlides().length - 1, true);
          return;
        }

        if (e.key.toLowerCase() === 'b' || e.key === '.') {
          e.preventDefault();
          this.previewEngine.toggleBlackout();
          return;
        }
      }
    });

    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && this.isPresentingFullscreen && !window.desktopAPI) {
        this.exitFullscreenPresentation();
      }
    });
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
