import { createSlideNode, generateId } from '../domain/defaults';
import { FallbackTransitionStyle, MediaAsset, SlideNode } from '../domain/types';
import { StagePlaybackEngine } from '../engine/StagePlaybackEngine';
import { AppLanguage, getLanguage, t } from '../i18n';

interface DemoSlideSpec {
  number: string;
  badge: string;
  title: string;
  subtitle: string;
  accentColor: string;
  secondaryColor: string;
  bgStart: string;
  bgEnd: string;
  orbX: number;
  orbY: number;
}

const DEMO_SPECS_AR: DemoSlideSpec[] = [
  {
    number: '01',
    badge: 'MOTION PRESENTATION ENGINE',
    title: 'شريحة المقدمة الرئيسية',
    subtitle: 'اضغط المسافة أو السهم لتشغيل فيديو الانتقال الحركي للشريحة التالية',
    accentColor: '#38BDF8',
    secondaryColor: '#818CF8',
    bgStart: '#070B19',
    bgEnd: '#0F172A',
    orbX: 0.25,
    orbY: 0.35,
  },
  {
    number: '02',
    badge: 'ZERO-FLICKER TRANSITIONS',
    title: 'انتقال حركي بدون أي تقطيع',
    subtitle: 'ينتقل الفيديو من الإطار الأخير للصورة الأولى إلى الإطار الأول للصورة التالية بدقة 100%',
    accentColor: '#A855F7',
    secondaryColor: '#EC4899',
    bgStart: '#0F0720',
    bgEnd: '#1E1035',
    orbX: 0.72,
    orbY: 0.32,
  },
  {
    number: '03',
    badge: 'SMART MEDIA PIPELINE',
    title: 'تعرّف ذكي على الصور والفيديوهات',
    subtitle: 'يدعم استيراد مجلد كامل من الصور وفيديوهات الانتقال ويربطها تلقائياً بالترتيب',
    accentColor: '#10B981',
    secondaryColor: '#06B6D4',
    bgStart: '#041318',
    bgEnd: '#08262C',
    orbX: 0.35,
    orbY: 0.68,
  },
  {
    number: '04',
    badge: 'READY FOR LIVE STAGE',
    title: 'تحكم كامل أثناء العرض المباشر',
    subtitle: 'وضع ملء الشاشة، التحكم في السرعة، التخطي الفوري، واستخراج الشرائح من الفيديو',
    accentColor: '#F59E0B',
    secondaryColor: '#EF4444',
    bgStart: '#180D05',
    bgEnd: '#271509',
    orbX: 0.65,
    orbY: 0.62,
  },
];

const DEMO_SPECS_EN: DemoSlideSpec[] = [
  {
    number: '01',
    badge: 'MOTION PRESENTATION ENGINE',
    title: 'Opening Title Keyframe',
    subtitle: 'Press Space or Arrow Right to launch the motion transition to Slide 02',
    accentColor: '#38BDF8',
    secondaryColor: '#818CF8',
    bgStart: '#070B19',
    bgEnd: '#0F172A',
    orbX: 0.25,
    orbY: 0.35,
  },
  {
    number: '02',
    badge: 'ZERO-FLICKER TRANSITIONS',
    title: 'Seamless Frame-Exact Motion',
    subtitle: 'Bridges the final frame of Slide 01 to the opening frame of Slide 02 with pixel accuracy',
    accentColor: '#A855F7',
    secondaryColor: '#EC4899',
    bgStart: '#0F0720',
    bgEnd: '#1E1035',
    orbX: 0.72,
    orbY: 0.32,
  },
  {
    number: '03',
    badge: 'SMART MEDIA PIPELINE',
    title: 'Smart Auto-Pairing Pipeline',
    subtitle: 'Drop a folder of images and transition clips to pair and order them automatically',
    accentColor: '#10B981',
    secondaryColor: '#06B6D4',
    bgStart: '#041318',
    bgEnd: '#08262C',
    orbX: 0.35,
    orbY: 0.68,
  },
  {
    number: '04',
    badge: 'READY FOR LIVE STAGE',
    title: 'Built for Live Stage Control',
    subtitle: 'Fullscreen Presenter (F5), variable playback speed, instant skip & hold-cue slicing',
    accentColor: '#F59E0B',
    secondaryColor: '#EF4444',
    bgStart: '#180D05',
    bgEnd: '#271509',
    orbX: 0.65,
    orbY: 0.62,
  },
];

function getDemoSpecs(lang: AppLanguage = getLanguage()): DemoSlideSpec[] {
  return lang === 'en' ? DEMO_SPECS_EN : DEMO_SPECS_AR;
}

export class DemoGenerator {
  private static drawSlideFrame(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    spec: DemoSlideSpec,
    morphProgress = 0,
    nextSpec?: DemoSlideSpec
  ): void {
    // 100% PIXEL PRECISION GUARANTEE:
    // Frame at progress <= 0 is bitwise-identical to static Slide 1
    // Frame at progress >= 1 is bitwise-identical to static Slide 2
    if (morphProgress >= 1 && nextSpec) {
      this.drawSlideFrame(ctx, width, height, nextSpec, 0);
      return;
    }
    if (morphProgress <= 0 && nextSpec) {
      this.drawSlideFrame(ctx, width, height, spec, 0);
      return;
    }

    const t = this.easeInOutCubic(morphProgress);

    const bg1 = nextSpec ? this.lerpHex(spec.bgStart, nextSpec.bgStart, t) : spec.bgStart;
    const bg2 = nextSpec ? this.lerpHex(spec.bgEnd, nextSpec.bgEnd, t) : spec.bgEnd;
    const accent = nextSpec
      ? this.lerpHex(spec.accentColor, nextSpec.accentColor, t)
      : spec.accentColor;
    const secondary = nextSpec
      ? this.lerpHex(spec.secondaryColor, nextSpec.secondaryColor, t)
      : spec.secondaryColor;

    // Background Gradient
    const grad = ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, bg1);
    grad.addColorStop(1, bg2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // Animated Grid Lines
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;
    const gridOffset = (morphProgress * 80) % 80;
    for (let x = -80; x < width + 80; x += 80) {
      ctx.beginPath();
      ctx.moveTo(x + gridOffset, 0);
      ctx.lineTo(x + gridOffset, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += 80) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.restore();

    // Glowing Orbs that travel smoothly during transition!
    const orbX = nextSpec
      ? (spec.orbX + (nextSpec.orbX - spec.orbX) * t) * width
      : spec.orbX * width;
    const orbY = nextSpec
      ? (spec.orbY + (nextSpec.orbY - spec.orbY) * t) * height
      : spec.orbY * height;

    const orbRadius = width * (0.28 + Math.sin(morphProgress * Math.PI) * 0.12);
    const radial = ctx.createRadialGradient(orbX, orbY, 10, orbX, orbY, orbRadius);
    radial.addColorStop(0, this.hexToRgba(accent, 0.42));
    radial.addColorStop(0.5, this.hexToRgba(secondary, 0.16));
    radial.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = radial;
    ctx.beginPath();
    ctx.arc(orbX, orbY, orbRadius, 0, Math.PI * 2);
    ctx.fill();

    // Motion Graphics Geometric Rings during transition (smooth 360-degree rotation)
    ctx.save();
    ctx.translate(orbX, orbY);
    ctx.rotate(t * Math.PI * 2);
    ctx.strokeStyle = this.hexToRgba(accent, 0.25 + Math.sin(morphProgress * Math.PI) * 0.35);
    ctx.lineWidth = 3;
    const ringSize = 180 + Math.sin(morphProgress * Math.PI) * 140;
    ctx.strokeRect(-ringSize / 2, -ringSize / 2, ringSize, ringSize);
    ctx.restore();

    // Render Card Content (Cross-morphing outgoing & incoming slide text)
    if (!nextSpec || morphProgress === 0) {
      this.drawSlideTypography(ctx, width, height, spec, 1, 0);
    } else if (morphProgress >= 1) {
      this.drawSlideTypography(ctx, width, height, nextSpec, 1, 0);
    } else {
      const outAlpha = Math.max(0, 1 - t * 1.5);
      const inAlpha = Math.max(0, (t - 0.3) / 0.7);
      if (outAlpha > 0) {
        this.drawSlideTypography(ctx, width, height, spec, outAlpha, -t * 120);
      }
      if (inAlpha > 0) {
        this.drawSlideTypography(ctx, width, height, nextSpec, inAlpha, (1 - t) * 120);
      }
    }
  }

  private static drawSlideTypography(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    spec: DemoSlideSpec,
    alpha: number,
    offsetY: number
  ): void {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(0, offsetY);

    // Glass Frame
    const cardW = width * 0.74;
    const cardH = height * 0.56;
    const cardX = (width - cardW) / 2;
    const cardY = (height - cardH) / 2;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.62)';
    ctx.strokeStyle = this.hexToRgba(spec.accentColor, 0.45);
    ctx.lineWidth = 2;
    this.roundRect(ctx, cardX, cardY, cardW, cardH, 28);
    ctx.fill();
    ctx.stroke();

    // Big Step Number
    ctx.fillStyle = this.hexToRgba(spec.accentColor, 0.16);
    ctx.font = '800 150px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(spec.number, cardX + 48, cardY + 165);

    // Badge
    ctx.fillStyle = spec.accentColor;
    ctx.font = '700 20px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(spec.badge, width / 2, cardY + 115);

    // Main Arabic Title
    ctx.fillStyle = '#F8FAFC';
    const maxTextWidth = cardW - 70;
    this.drawFittedText(ctx, spec.title, width / 2, cardY + 235, maxTextWidth, 54, 800, 'Cairo, sans-serif');

    // Subtitle
    ctx.fillStyle = '#CBD5E1';
    this.drawFittedText(ctx, spec.subtitle, width / 2, cardY + 315, maxTextWidth, 24, 500, 'Cairo, sans-serif');

    // Accent bar
    ctx.fillStyle = spec.accentColor;
    this.roundRect(ctx, width / 2 - 90, cardY + 365, 180, 6, 3);
    ctx.fill();

    ctx.restore();
  }

  private static drawFittedText(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    defaultFontSize: number,
    weight: number,
    fontFamily: string
  ): void {
    ctx.textAlign = 'center';
    let fontSize = defaultFontSize;
    ctx.font = `${weight} ${fontSize}px ${fontFamily}`;
    let measured = ctx.measureText(text).width;

    while (measured > maxWidth && fontSize > defaultFontSize * 0.55) {
      fontSize -= 1;
      ctx.font = `${weight} ${fontSize}px ${fontFamily}`;
      measured = ctx.measureText(text).width;
    }

    if (measured > maxWidth) {
      const words = text.split(' ');
      const lines: string[] = [];
      let currentLine = '';

      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        if (ctx.measureText(testLine).width <= maxWidth) {
          currentLine = testLine;
        } else {
          if (currentLine) lines.push(currentLine);
          currentLine = word;
        }
      }
      if (currentLine) lines.push(currentLine);

      const maxLines = 2;
      const displayLines = lines.slice(0, maxLines);
      if (lines.length > maxLines) {
        let last = displayLines[maxLines - 1];
        while (last.length > 0 && ctx.measureText(last + '...').width > maxWidth) {
          last = last.slice(0, -1);
        }
        displayLines[maxLines - 1] = last + '...';
      }

      const lineHeight = fontSize * 1.35;
      const startY = y - ((displayLines.length - 1) * lineHeight) / 2;
      displayLines.forEach((line, idx) => {
        ctx.fillText(line, x, startY + idx * lineHeight);
      });
    } else {
      ctx.fillText(text, x, y);
    }
  }

  static async generateDemoSlides(
    onProgress?: (label: string) => void
  ): Promise<SlideNode[]> {
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      try {
        await document.fonts.ready;
      } catch {
        // Fallback if fonts.ready fails
      }
    }

    const width = 1280;
    const height = 720;

    onProgress?.(t('core.demoProgressSlides'));
    const specs = getDemoSpecs();
    const slideImages: MediaAsset[] = [];

    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const imgAsset = await this.renderStaticSlideAsset(spec, i, width, height);
      slideImages.push(imgAsset);
    }

    const nodes: SlideNode[] = slideImages.map((img, i) => {
      const node = createSlideNode(img, i, 'zoom-morph');
      node.title = `${specs[i].number} - ${specs[i].title}`;
      return node;
    });

    // Generate real WebM motion transition videos between Slide[i] and Slide[i+1]
    for (let i = 0; i < specs.length - 1; i++) {
      onProgress?.(t('core.demoProgressVideo', { from: i + 1, to: i + 2 }));
      try {
        const { videoAsset, reverseFrames } = await this.recordMorphVideoAsset(
          specs[i],
          specs[i + 1],
          i,
          width,
          height
        );
        nodes[i].transitionToNext.videoAsset = videoAsset;
        if (reverseFrames && reverseFrames.length > 0) {
          StagePlaybackEngine.cacheReverseFrames(nodes[i].transitionToNext.id, reverseFrames);
          StagePlaybackEngine.cacheReverseFrames(videoAsset.id, reverseFrames);
        }
      } catch {
        // Fallback if MediaRecorder is unavailable
      }
    }

    return nodes;
  }

  private static renderStaticSlideAsset(
    spec: DemoSlideSpec,
    index: number,
    width: number,
    height: number
  ): Promise<MediaAsset> {
    return new Promise((resolve, reject) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas context unavailable'));
        return;
      }

      this.drawSlideFrame(ctx, width, height, spec, 0);
      const thumbUrl = canvas.toDataURL('image/jpeg', 0.8);

      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Failed to create slide blob'));
          return;
        }
        const fileName = `0${index + 1}_Slide_${spec.number}.png`;
        const file = new File([blob], fileName, { type: 'image/png' });
        const objectUrl = URL.createObjectURL(file);
        resolve({
          id: generateId('img'),
          name: fileName,
          kind: 'image',
          mimeType: 'image/png',
          extension: 'png',
          objectUrl,
          fileSize: file.size,
          width,
          height,
          durationSec: 0,
          thumbnailUrl: thumbUrl,
          rawFile: file,
        });
      }, 'image/png');
    });
  }

  private static recordMorphVideoAsset(
    fromSpec: DemoSlideSpec,
    toSpec: DemoSlideSpec,
    index: number,
    width: number,
    height: number
  ): Promise<{ videoAsset: MediaAsset; reverseFrames: HTMLCanvasElement[] }> {
    return new Promise((resolve, reject) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx || typeof canvas.captureStream !== 'function') {
        reject(new Error('MediaRecorder stream capture unsupported'));
        return;
      }

      this.drawSlideFrame(ctx, width, height, fromSpec, 0, toSpec);
      const firstThumb = canvas.toDataURL('image/jpeg', 0.75);

      const stream = canvas.captureStream(60);
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : MediaRecorder.isTypeSupported('video/webm')
          ? 'video/webm'
          : '';

      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 })
        : new MediaRecorder(stream);

      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };

      let recordStartTime = 0;
      let recordStopTime = 0;

      // Direct, zero-freeze morph animation:
      // warmupFrames = 2 (~33ms) allows MediaRecorder to establish initial keyframe without noticeable freeze
      // morphFrames = 48 (~800ms) smooth 60fps morph progression
      // holdFinalFrames = 6 (~100ms) hold on Slide 2 guarantees 100% completion before video ends
      const warmupFrames = 2;
      const morphFrames = 48;
      const holdFinalFrames = 6;
      const frameIntervalMs = 16.666;

      const reverseFrames: HTMLCanvasElement[] = [];

      const captureCanvasFrame = () => {
        const fCanvas = document.createElement('canvas');
        fCanvas.width = width;
        fCanvas.height = height;
        const fCtx = fCanvas.getContext('2d');
        if (fCtx) {
          fCtx.drawImage(canvas, 0, 0);
          reverseFrames.push(fCanvas);
        }
      };

      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        this.drawSlideFrame(ctx, width, height, fromSpec, 1, toSpec);
        const lastThumb = canvas.toDataURL('image/jpeg', 0.75);
        const blob = new Blob(chunks, { type: 'video/webm' });
        const fileName = `0${index + 1}_Transition_${fromSpec.number}_to_${toSpec.number}.webm`;
        const file = new File([blob], fileName, { type: 'video/webm' });
        const objectUrl = URL.createObjectURL(file);

        // Accurate duration: use elapsed time up to recorder.stop() to prevent
        // inflation by asynchronous onstop flush latency in Chromium
        const scheduledMs = (warmupFrames + morphFrames + holdFinalFrames) * frameIntervalMs;
        const elapsedMs =
          recordStopTime > recordStartTime ? recordStopTime - recordStartTime : scheduledMs;
        const durationSec = Math.max(0.3, Number((elapsedMs / 1000).toFixed(2)));

        resolve({
          videoAsset: {
            id: generateId('vid'),
            name: fileName,
            kind: 'video',
            mimeType: 'video/webm',
            extension: 'webm',
            objectUrl,
            fileSize: file.size,
            width,
            height,
            durationSec,
            thumbnailUrl: firstThumb,
            lastFrameUrl: lastThumb,
            rawFile: file,
          },
          reverseFrames,
        });
      };

      recorder.onerror = () => {
        stream.getTracks().forEach((track) => track.stop());
        reject(new Error(t('core.demoRecordError')));
      };

      recorder.start();
      recordStartTime = performance.now();

      let warmupIndex = 0;
      let morphIndex = 0;
      let holdIndex = 0;

      const scheduleNext =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame
          : (cb: () => void) => setTimeout(cb, 16);

      const videoTrack = stream.getVideoTracks()[0] as any;

      const stepWarmup = () => {
        this.drawSlideFrame(ctx, width, height, fromSpec, 0, toSpec);
        if (typeof videoTrack?.requestFrame === 'function') {
          videoTrack.requestFrame();
        }
        if (warmupIndex === 0) {
          captureCanvasFrame(); // Capture exact Slide 1 as frame 0
        }
        warmupIndex++;
        if (warmupIndex < warmupFrames) {
          scheduleNext(stepWarmup);
        } else {
          stepMorph();
        }
      };

      const stepMorph = () => {
        const progress = Math.min(1, (morphIndex + 1) / morphFrames);
        this.drawSlideFrame(ctx, width, height, fromSpec, progress, toSpec);
        if (typeof videoTrack?.requestFrame === 'function') {
          videoTrack.requestFrame();
        }
        captureCanvasFrame();
        morphIndex++;
        if (morphIndex < morphFrames) {
          scheduleNext(stepMorph);
        } else {
          stepHold();
        }
      };

      const stepHold = () => {
        this.drawSlideFrame(ctx, width, height, fromSpec, 1, toSpec);
        if (typeof videoTrack?.requestFrame === 'function') {
          videoTrack.requestFrame();
        }
        holdIndex++;
        if (holdIndex < holdFinalFrames) {
          scheduleNext(stepHold);
        } else {
          recordStopTime = performance.now();
          recorder.stop();
        }
      };

      stepWarmup();
    });
  }

  static async generateTransitionVideoBetweenSlides(
    fromSlide: SlideNode,
    toSlide: SlideNode,
    style: FallbackTransitionStyle = 'zoom-morph',
    durationMs = 900
  ): Promise<{ videoAsset: MediaAsset; reverseFrames: HTMLCanvasElement[] }> {
    const loadImage = (objectUrl: string): Promise<HTMLImageElement> =>
      new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(t('core.demoLoadSlideImgError')));
        image.src = objectUrl;
      });
    const [fromImage, toImage] = await Promise.all([
      loadImage(fromSlide.imageAsset.objectUrl),
      loadImage(toSlide.imageAsset.objectUrl),
    ]);

    const width = Math.min(fromSlide.imageAsset.width || 1280, 1920);
    const height = Math.min(fromSlide.imageAsset.height || 720, 1080);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof canvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') {
      throw new Error('MediaRecorder stream capture unsupported');
    }

    const drawImage = (image: HTMLImageElement, offsetX: number, scale: number, alpha: number) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(
        image,
        offsetX + (width - width * scale) / 2,
        (height - height * scale) / 2,
        width * scale,
        height * scale
      );
      ctx.restore();
    };
    const drawFrame = (rawProgress: number) => {
      const t = this.easeInOutCubic(rawProgress);
      ctx.fillStyle = '#05070B';
      ctx.fillRect(0, 0, width, height);

      if (style === 'slide-push') {
        drawImage(fromImage, -t * width, 1, 1);
        drawImage(toImage, (1 - t) * width, 1, 1);
      } else if (style === 'crossfade') {
        drawImage(fromImage, 0, 1, 1);
        drawImage(toImage, 0, 1, t);
      } else if (style === 'wipe-reveal') {
        drawImage(fromImage, 0, 1, 1);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, width * t, height);
        ctx.clip();
        drawImage(toImage, 0, 1, 1);
        ctx.restore();
      } else if (style === 'iris-spotlight') {
        drawImage(fromImage, 0, 1, Math.max(0, 1 - t * 0.25));
        const maxRadius = Math.hypot(width, height) * 0.55;
        const radius = Math.max(1, maxRadius * t);
        ctx.save();
        ctx.beginPath();
        ctx.arc(width / 2, height / 2, radius, 0, Math.PI * 2);
        ctx.clip();
        drawImage(toImage, 0, 1, 1);
        ctx.restore();
      } else {
        drawImage(fromImage, 0, 1 + t * 0.14, 1 - t);
        drawImage(toImage, 0, 0.88 + t * 0.12, t);
        if (rawProgress > 0 && rawProgress < 1) {
          ctx.save();
          ctx.globalAlpha = Math.sin(rawProgress * Math.PI) * 0.2;
          ctx.strokeStyle = '#38BDF8';
          ctx.shadowColor = '#38BDF8';
          ctx.shadowBlur = Math.min(width, height) * 0.04;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(width / 2, height / 2, Math.min(width, height) * (0.18 + t * 0.1), 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      }
    };

    drawFrame(0);
    const firstThumb = canvas.toDataURL('image/jpeg', 0.75);
    const stream = canvas.captureStream(60);
    let frameTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : MediaRecorder.isTypeSupported('video/webm')
          ? 'video/webm'
          : '';
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 })
        : new MediaRecorder(stream);
      const videoTrack = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
      const warmupFrames = 2;
      const morphFrames = Math.max(24, Math.min(90, Math.round((durationMs / 1000) * 60)));
      const holdFinalFrames = 5;
      const totalFrames = warmupFrames + morphFrames + holdFinalFrames;
      const frameIntervalMs = 1000 / 60;
      const reverseFrames: HTMLCanvasElement[] = [];
      const chunks: BlobPart[] = [];
      let recordStartTime = 0;
      let recordStopTime = 0;
      let failed = false;

      return await new Promise((resolve, reject) => {
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunks.push(e.data);
        };
        recorder.onstop = () => {
          if (failed) return;
          const lastThumb = canvas.toDataURL('image/jpeg', 0.75);
          const fileName = `transition_${fromSlide.id}_to_${toSlide.id}.webm`;
          const file = new File(chunks, fileName, { type: 'video/webm' });
          const elapsedMs = recordStopTime > recordStartTime
            ? recordStopTime - recordStartTime
            : totalFrames * frameIntervalMs;
          resolve({
            videoAsset: {
              id: generateId('vid'),
              name: fileName,
              kind: 'video',
              mimeType: 'video/webm',
              extension: 'webm',
              objectUrl: URL.createObjectURL(file),
              fileSize: file.size,
              width,
              height,
              durationSec: Math.max(0.3, Number((elapsedMs / 1000).toFixed(2))),
              thumbnailUrl: firstThumb,
              lastFrameUrl: lastThumb,
              rawFile: file,
            },
            reverseFrames,
          });
        };
        const fail = (error: unknown) => {
          failed = true;
          reject(error);
          if (recorder.state !== 'inactive') recorder.stop();
        };
        recorder.onerror = () => fail(new Error(t('core.transRecordError')));

        let frameIndex = 0;
        const step = () => {
          if (recorder.state !== 'recording') return;
          try {
            if (frameIndex === totalFrames) {
              recordStopTime = performance.now();
              recorder.stop();
              return;
            }
            const rawProgress = Math.max(0, Math.min(1, (frameIndex - warmupFrames + 1) / morphFrames));
            drawFrame(rawProgress);
            if (typeof videoTrack?.requestFrame === 'function') videoTrack.requestFrame();
            if (frameIndex === 0 || (frameIndex >= warmupFrames && frameIndex < warmupFrames + morphFrames)) {
              const frame = document.createElement('canvas');
              frame.width = width;
              frame.height = height;
              const frameCtx = frame.getContext('2d');
              if (frameCtx) {
                frameCtx.drawImage(canvas, 0, 0);
                reverseFrames.push(frame);
              }
            }
            frameIndex++;
            frameTimer = setTimeout(step, Math.max(0, recordStartTime + frameIndex * frameIntervalMs - performance.now()));
          } catch (error) {
            fail(error);
          }
        };

        recorder.start();
        recordStartTime = performance.now();
        step();
      });
    } finally {
      clearTimeout(frameTimer);
      stream.getTracks().forEach((track) => track.stop());
    }
  }

  private static easeInOutCubic(x: number): number {
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  }

  private static roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number
  ): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  private static hexToRgba(hex: string, alpha: number): string {
    const clean = hex.replace('#', '');
    const num = parseInt(clean, 16);
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  private static lerpHex(hexA: string, hexB: string, t: number): string {
    const a = parseInt(hexA.replace('#', ''), 16);
    const b = parseInt(hexB.replace('#', ''), 16);
    const r = Math.round(((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * t);
    const g = Math.round(((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * t);
    const bl = Math.round((a & 255) + ((b & 255) - (a & 255)) * t);
    return `#${((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1)}`;
  }
}
