import { generateId } from '../domain/defaults';
import { MediaAsset } from '../domain/types';

/**
 * Extracts a full-resolution static Slide Image (PNG MediaAsset) from either
 * the first frame or the final frame of a Transition Video.
 * This ensures 100% pixel-exact continuity between a motion video and its landing slide.
 */
export class FrameExtractor {
  /**
   * Extracts a full-resolution PNG MediaAsset at the exact timestamp
   * `Math.max(0, timeSec)` (clamped to `Math.max(0, duration - 0.001)` once metadata loads).
   */
  static async extractFrameAtTimeAsSlideAsset(
    videoAsset: MediaAsset,
    timeSec: number,
    customLabel?: string
  ): Promise<MediaAsset> {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.preload = 'auto';
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';

      let settled = false;
      let timeoutId: number | null = null;

      const cleanup = () => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        video.onloadedmetadata = null;
        video.onseeked = null;
        video.onerror = null;
        video.removeAttribute('src');
        video.load();
      };

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      // Initial metadata safety timeout (5000ms)
      timeoutId = window.setTimeout(() => {
        fail(new Error(`انتهت مهلة تحميل بيانات الفيديو لاستخراج الفريم (${videoAsset.name})`));
      }, 5000);

      video.onloadedmetadata = async () => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        let duration =
          Number.isFinite(video.duration) && video.duration > 0
            ? video.duration
            : videoAsset.durationSec > 0
              ? videoAsset.durationSec
              : 1.0;

        // Safe WebM duration handling if duration is Infinity
        if (!Number.isFinite(video.duration) || video.duration === Infinity) {
          await new Promise<void>((res) => {
            const onDur = () => {
              video.removeEventListener('durationchange', onDur);
              res();
            };
            video.addEventListener('durationchange', onDur, { once: true });
            try {
              video.currentTime = 1e101;
            } catch {
              res();
            }
            window.setTimeout(() => {
              video.removeEventListener('durationchange', onDur);
              res();
            }, 500);
          });
          if (Number.isFinite(video.duration) && video.duration > 0) {
            duration = video.duration;
          }
        }

        // Accurate timing offset without arbitrary deductions
        const requestedTime =
          Number.isFinite(timeSec) && timeSec >= 0
            ? Math.max(0, timeSec)
            : Math.max(0, duration - 0.001);
        const targetTime = Math.min(requestedTime, Math.max(0, duration - 0.001));

        // Dedicated 3000ms safety timeout specifically around seeking
        timeoutId = window.setTimeout(() => {
          if (!settled) {
            // Force capture rather than hanging if browser seeked event is delayed
            video.dispatchEvent(new Event('seeked'));
          }
        }, 3000);

        video.onseeked = () => {
          try {
            const width = video.videoWidth || 1920;
            const height = video.videoHeight || 1080;
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
              fail(new Error('تعذر إنشاء سياق الرسم لاستخراج الشريحة'));
              return;
            }
            ctx.drawImage(video, 0, 0, width, height);

            // Create thumbnail
            const thumbCanvas = document.createElement('canvas');
            thumbCanvas.width = 320;
            thumbCanvas.height = Math.round((320 * height) / width);
            const thumbCtx = thumbCanvas.getContext('2d');
            thumbCtx?.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
            const thumbnailUrl = thumbCanvas.toDataURL('image/jpeg', 0.85);

            canvas.toBlob(
              (blob) => {
                cleanup();
                if (settled) return;
                settled = true;
                if (!blob) {
                  reject(new Error('تعذر تحويل الفريم المستخرج إلى صورة'));
                  return;
                }
                const baseName = videoAsset.name.replace(/\.[^/.]+$/, '');
                const fileName = customLabel || `${baseName}_مستخلص.png`;
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
                  thumbnailUrl,
                  rawFile: file,
                });
              },
              'image/png',
              1.0
            );
          } catch (err) {
            fail(err instanceof Error ? err : new Error(String(err)));
          }
        };

        try {
          video.currentTime = targetTime;
        } catch {
          video.dispatchEvent(new Event('seeked'));
        }
      };

      video.onerror = () => {
        fail(new Error(`تعذر قراءة الفيديو لاستخراج الفريم: ${videoAsset.name}`));
      };

      video.src = videoAsset.objectUrl;
    });
  }

  /**
   * Extracts a full-resolution static Slide Image (PNG MediaAsset) from either
   * the first frame or the final frame of a Transition Video.
   * This ensures 100% pixel-exact continuity between a motion video and its landing slide.
   */
  static async extractFrameAsSlideAsset(
    videoAsset: MediaAsset,
    position: 'first' | 'last',
    customLabel?: string
  ): Promise<MediaAsset> {
    const baseName = videoAsset.name.replace(/\.[^/.]+$/, '');
    const suffix = position === 'first' ? 'بداية' : 'نهاية';
    const fileName = customLabel || `${baseName}_${suffix}.png`;
    // For 'last' pass negative sentinel - timeSec >= 0 triggers end-of-video logic in extractFrameAtTimeAsSlideAsset
    const timeSec = position === 'first' ? 0 : -1;
    return this.extractFrameAtTimeAsSlideAsset(videoAsset, timeSec, fileName);
  }
}
