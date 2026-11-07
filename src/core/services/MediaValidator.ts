import { generateId } from '../domain/defaults';
import { MediaAsset, MediaKind, ValidationResult } from '../domain/types';

export const ALLOWED_IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'avif',
  'svg',
  'bmp',
]);

export const ALLOWED_VIDEO_EXTENSIONS = new Set([
  'mp4',
  'webm',
  'mov',
  'm4v',
  'mkv',
  'ogv',
]);

export const IMAGE_ACCEPT_STRING =
  '.png,.jpg,.jpeg,.webp,.avif,.svg,.bmp,image/png,image/jpeg,image/webp,image/avif,image/svg+xml';

export const VIDEO_ACCEPT_STRING =
  '.mp4,.webm,.mov,.m4v,.mkv,video/mp4,video/webm,video/quicktime';

export const ALL_MEDIA_ACCEPT_STRING = `${IMAGE_ACCEPT_STRING},${VIDEO_ACCEPT_STRING}`;

export class MediaValidator {
  static getExtension(filename: string): string {
    const parts = filename.toLowerCase().trim().split('.');
    return parts.length > 1 ? parts[parts.length - 1] : '';
  }

  static validateFile(file: File, expectedKind?: MediaKind): ValidationResult {
    const ext = this.getExtension(file.name);
    const mime = (file.type || '').toLowerCase();

    const isImage =
      ALLOWED_IMAGE_EXTENSIONS.has(ext) || mime.startsWith('image/');
    const isVideo =
      ALLOWED_VIDEO_EXTENSIONS.has(ext) || mime.startsWith('video/');

    if (!isImage && !isVideo) {
      return {
        valid: false,
        kind: null,
        extension: ext,
        errorReason: `صيغة الملف (.${ext || 'غير معروف'}) غير مدعومة. الصيغ المدعومة للصور: PNG, JPG, WEBP وللفيديو: MP4, WEBM, MOV.`,
      };
    }

    const detectedKind: MediaKind = isVideo ? 'video' : 'image';

    if (expectedKind && detectedKind !== expectedKind) {
      const expectedLabel =
        expectedKind === 'image' ? 'صورة شريحة ثابتة (PNG/JPG/WEBP)' : 'فيديو انتقال حركي (MP4/WEBM/MOV)';
      const actualLabel = detectedKind === 'image' ? 'صورة' : 'فيديو';
      return {
        valid: false,
        kind: detectedKind,
        extension: ext,
        errorReason: `هذا المكان مخصص لـ ${expectedLabel}، لكن الملف المرفوع هو ${actualLabel} (${file.name}).`,
      };
    }

    if (file.size === 0) {
      return {
        valid: false,
        kind: detectedKind,
        extension: ext,
        errorReason: `الملف (${file.name}) فارغ أو تالف (0 بايت).`,
      };
    }

    return {
      valid: true,
      kind: detectedKind,
      extension: ext,
    };
  }

  static async ingestFile(file: File, expectedKind?: MediaKind): Promise<MediaAsset> {
    const validation = this.validateFile(file, expectedKind);
    if (!validation.valid || !validation.kind) {
      throw new Error(validation.errorReason || 'ملف غير صالح');
    }

    if (validation.kind === 'image') {
      return this.ingestImageFile(file, validation.extension);
    } else {
      return this.ingestVideoFile(file, validation.extension);
    }
  }

  private static ingestImageFile(file: File, extension: string): Promise<MediaAsset> {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();

      img.onload = () => {
        const width = img.naturalWidth || 1920;
        const height = img.naturalHeight || 1080;
        const thumbUrl = this.renderCanvasThumbnail(img, width, height, 320);

        resolve({
          id: generateId('img'),
          name: file.name,
          kind: 'image',
          mimeType: file.type || `image/${extension === 'jpg' ? 'jpeg' : extension}`,
          extension,
          objectUrl,
          fileSize: file.size,
          width,
          height,
          durationSec: 0,
          thumbnailUrl: thumbUrl || objectUrl,
          rawFile: file,
        });
      };

      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error(`تعذر قراءة ملف الصورة: ${file.name}`));
      };

      img.src = objectUrl;
    });
  }

  private static ingestVideoFile(file: File, extension: string): Promise<MediaAsset> {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;

      let settled = false;
      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(objectUrl);
        reject(new Error(msg));
      };

      const timeoutId = window.setTimeout(() => {
        fail(`انتهت مهلة قراءة بيانات الفيديو: ${file.name}`);
      }, 12000);

      video.onloadedmetadata = async () => {
        try {
          const width = video.videoWidth || 1920;
          const height = video.videoHeight || 1080;
          let durationSec =
            Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;

          // Safe WebM duration handling (Chrome WebM duration = Infinity issue)
          if (!Number.isFinite(video.duration) || video.duration === Infinity) {
            await new Promise<void>((res) => {
              const onDurChange = () => {
                video.removeEventListener('durationchange', onDurChange);
                res();
              };
              video.addEventListener('durationchange', onDurChange, { once: true });
              try {
                video.currentTime = 1e101;
              } catch {
                res();
              }
              window.setTimeout(() => {
                video.removeEventListener('durationchange', onDurChange);
                try {
                  video.currentTime = 0;
                } catch {
                  // ignore
                }
                res();
              }, 400);
            });
            durationSec =
              Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1.5;
            try {
              video.currentTime = 0;
            } catch {
              // ignore
            }
          }

          const firstFrameUrl = await this.captureVideoFrameAt(
            video,
            0,
            width,
            height,
            320
          );
          const lastFrameUrl = await this.captureVideoFrameAt(
            video,
            Math.max(0, durationSec - 0.001),
            width,
            height,
            320
          );

          window.clearTimeout(timeoutId);
          settled = true;

          resolve({
            id: generateId('vid'),
            name: file.name,
            kind: 'video',
            mimeType: file.type || `video/${extension}`,
            extension,
            objectUrl,
            fileSize: file.size,
            width,
            height,
            durationSec,
            thumbnailUrl: firstFrameUrl,
            lastFrameUrl: lastFrameUrl || firstFrameUrl,
            rawFile: file,
          });
        } catch (err) {
          window.clearTimeout(timeoutId);
          fail(err instanceof Error ? err.message : `خطأ أثناء تحليل الفيديو: ${file.name}`);
        }
      };

      video.onerror = () => {
        window.clearTimeout(timeoutId);
        fail(`تعذر فك ترميز ملف الفيديو (${file.name}). تأكد أنه بصيغة MP4 (H.264) أو WebM.`);
      };

      video.src = objectUrl;
    });
  }

  private static captureVideoFrameAt(
    video: HTMLVideoElement,
    timeSec: number,
    width: number,
    height: number,
    maxThumbWidth: number
  ): Promise<string> {
    return new Promise((resolve) => {
      let resolved = false;
      let timer: number | null = null;

      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
        video.removeEventListener('seeked', onSeeked);
      };

      const onSeeked = () => {
        cleanup();
        const dataUrl = this.renderCanvasThumbnail(video, width, height, maxThumbWidth);
        resolve(dataUrl);
      };

      timer = window.setTimeout(() => {
        cleanup();
        const fallback = this.renderCanvasThumbnail(video, width, height, maxThumbWidth);
        resolve(fallback);
      }, 3000);

      video.addEventListener('seeked', onSeeked, { once: true });
      try {
        video.currentTime = Math.max(0, timeSec);
      } catch {
        cleanup();
        resolve('');
      }
    });
  }

  private static renderCanvasThumbnail(
    source: HTMLImageElement | HTMLVideoElement,
    sourceWidth: number,
    sourceHeight: number,
    maxWidth = 320
  ): string {
    try {
      const ratio = sourceHeight / (sourceWidth || 1);
      const targetWidth = Math.min(maxWidth, sourceWidth || maxWidth);
      const targetHeight = Math.max(1, Math.round(targetWidth * ratio));
      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return '';
      ctx.drawImage(source, 0, 0, targetWidth, targetHeight);
      return canvas.toDataURL('image/jpeg', 0.82);
    } catch {
      return '';
    }
  }
}
