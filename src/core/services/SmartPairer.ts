import { createSlideNode } from '../domain/defaults';
import {
  BatchImportReport,
  FallbackTransitionStyle,
  MediaAsset,
  SlideNode,
} from '../domain/types';
import { FrameExtractor } from './FrameExtractor';
import { MediaValidator } from './MediaValidator';

const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

/**
 * SmartPairer handles batch ingestion of files:
 * 1. Mixed Images + Videos: Sorts naturally and pairs Slide[i] with Video[i] -> Slide[i+1].
 * 2. Images Only: Creates slides in natural order.
 * 3. Videos Only: Automatically extracts Intro frame + End frames of each transition video so
 *    even a folder of pure Motion Graphics transition clips becomes an interactive presentation!
 */
export class SmartPairer {
  static async processBatchFiles(
    files: File[],
    existingSlidesCount: number,
    defaultFallback: FallbackTransitionStyle = 'crossfade'
  ): Promise<{
    newSlides: SlideNode[];
    unpairedVideos: MediaAsset[];
    report: BatchImportReport;
  }> {
    const sortedFiles = [...files].sort((a, b) =>
      naturalCollator.compare(a.name, b.name)
    );

    const imageAssets: MediaAsset[] = [];
    const videoAssets: MediaAsset[] = [];
    const rejectedFiles: Array<{ name: string; reason: string }> = [];

    for (const file of sortedFiles) {
      const check = MediaValidator.validateFile(file);
      if (!check.valid) {
        rejectedFiles.push({
          name: file.name,
          reason: check.errorReason || 'ملف غير مدعوم',
        });
        continue;
      }

      try {
        const asset = await MediaValidator.ingestFile(file);
        if (asset.kind === 'image') {
          imageAssets.push(asset);
        } else {
          videoAssets.push(asset);
        }
      } catch (err) {
        rejectedFiles.push({
          name: file.name,
          reason: err instanceof Error ? err.message : 'خطأ في قراءة الملف',
        });
      }
    }

    const newSlides: SlideNode[] = [];
    const unpairedVideos: MediaAsset[] = [];
    let transitionsMatched = 0;

    // Case A: User dropped both Images (Slides) and Videos (Transitions) or Images only
    if (imageAssets.length > 0) {
      const usedVideoIndices = new Set<number>();

      for (let i = 0; i < imageAssets.length; i++) {
        const slideNode = createSlideNode(
          imageAssets[i],
          existingSlidesCount + i,
          defaultFallback
        );

        // Try to match video by filename first (01_to_02, numeric prefixes)
        let matchedVidIdx = -1;
        for (let v = 0; v < videoAssets.length; v++) {
          if (usedVideoIndices.has(v)) continue;
          const vidTarget = SmartPairer.extractSlideIndexFromFilename(videoAssets[v].name);
          if (vidTarget === i || vidTarget === (existingSlidesCount + i)) {
            matchedVidIdx = v;
            break;
          }
        }

        // If no filename match, take next available video sequentially
        if (matchedVidIdx === -1) {
          for (let v = 0; v < videoAssets.length; v++) {
            if (!usedVideoIndices.has(v)) {
              matchedVidIdx = v;
              break;
            }
          }
        }

        if (matchedVidIdx !== -1) {
          usedVideoIndices.add(matchedVidIdx);
          slideNode.transitionToNext.videoAsset = videoAssets[matchedVidIdx];
          transitionsMatched++;
        }

        newSlides.push(slideNode);
      }

      // Collect remaining videos
      for (let v = 0; v < videoAssets.length; v++) {
        if (!usedVideoIndices.has(v)) {
          unpairedVideos.push(videoAssets[v]);
        }
      }
    }
    // Case B: User dropped ONLY Motion Graphics Transition Videos (no separate images)
    // If empty project: Auto-extract intro slide + subsequent slides from each video's last frame
    else if (videoAssets.length > 0 && existingSlidesCount === 0) {
      const firstVideo = videoAssets[0];
      const introImage = await FrameExtractor.extractFrameAsSlideAsset(
        firstVideo,
        'first',
        `مقدمة_${firstVideo.name.replace(/\.[^/.]+$/, '')}.png`
      );
      const introSlide = createSlideNode(introImage, 0, defaultFallback);
      introSlide.title = 'شريحة المقدمة (المستخرجة)';
      introSlide.transitionToNext.videoAsset = firstVideo;
      transitionsMatched++;
      newSlides.push(introSlide);

      for (let i = 0; i < videoAssets.length; i++) {
        const currentVid = videoAssets[i];
        const nextVid = i + 1 < videoAssets.length ? videoAssets[i + 1] : null;
        const endFrameImage = await FrameExtractor.extractFrameAsSlideAsset(
          currentVid,
          'last',
          `شريحة_${i + 2}.png`
        );
        const landingSlide = createSlideNode(
          endFrameImage,
          i + 1,
          defaultFallback
        );
        landingSlide.title = `شريحة ${i + 2}`;
        if (nextVid) {
          landingSlide.transitionToNext.videoAsset = nextVid;
          transitionsMatched++;
        }
        newSlides.push(landingSlide);
      }
    }
    // Case C: Slides exist and additional videos are dropped:
    // Match videos by filename (01_to_02, numeric prefix), and extract landing/intro slides as needed
    else if (videoAssets.length > 0 && existingSlidesCount > 0) {
      let totalSlides = existingSlidesCount;

      for (let i = 0; i < videoAssets.length; i++) {
        const vid = videoAssets[i];
        const parsed = SmartPairer.parseIndicesFromFilename(vid.name);

        let fromIdx: number;
        let toIdx: number;

        if (parsed !== null) {
          fromIdx = parsed.fromIndex;
          toIdx = parsed.toIndex ?? fromIdx + 1;
        } else {
          // If no filename match, sequentially target the next slide needing a video
          fromIdx = Math.min(existingSlidesCount + newSlides.length, totalSlides);
          toIdx = fromIdx + 1;
        }

        // 1. If starting slide does not exist, extract it from the first frame of the video
        if (fromIdx >= totalSlides) {
          try {
            const startFrame = await FrameExtractor.extractFrameAsSlideAsset(
              vid,
              'first',
              `شريحة_${totalSlides + 1}_بداية.png`
            );
            const startSlide = createSlideNode(
              startFrame,
              totalSlides,
              defaultFallback
            );
            startSlide.title = `شريحة ${totalSlides + 1} (بداية ${vid.name.replace(/\.[^/.]+$/, '')})`;
            newSlides.push(startSlide);
            totalSlides++;
          } catch {
            // Ignore
          }
        }

        // 2. If destination landing slide does not exist, extract it from the last frame of the video
        if (toIdx >= totalSlides) {
          try {
            const endFrame = await FrameExtractor.extractFrameAsSlideAsset(
              vid,
              'last',
              `شريحة_${totalSlides + 1}_نهاية.png`
            );
            const landingSlide = createSlideNode(
              endFrame,
              totalSlides,
              defaultFallback
            );
            landingSlide.title = `شريحة ${totalSlides + 1} (نهاية ${vid.name.replace(/\.[^/.]+$/, '')})`;
            newSlides.push(landingSlide);
            totalSlides++;
          } catch {
            // Ignore
          }
        }

        // 3. Attach video to the source slide
        if (fromIdx < existingSlidesCount) {
          unpairedVideos.push(vid);
          transitionsMatched++;
        } else {
          const newSlideIndex = fromIdx - existingSlidesCount;
          if (newSlideIndex >= 0 && newSlideIndex < newSlides.length) {
            newSlides[newSlideIndex].transitionToNext.videoAsset = vid;
            transitionsMatched++;
          } else {
            unpairedVideos.push(vid);
          }
        }
      }
    }

    return {
      newSlides,
      unpairedVideos,
      report: {
        slidesAdded: newSlides.length,
        transitionsMatched,
        rejectedFiles,
      },
    };
  }

  static parseIndicesFromFilename(name: string): { fromIndex: number; toIndex?: number } | null {
    // 1. Matches "01_to_02", "1_to_2", "01-to-02", "1-2", "01_02"
    const pairMatch = name.match(
      /(?:^|[^\d])(\d+)\s*(?:_to_|-to-|\s+to\s+|_|-)\s*(\d+)(?:\.|$|[^\d])/i
    );
    if (pairMatch) {
      const fromNum = parseInt(pairMatch[1], 10);
      const toNum = parseInt(pairMatch[2], 10);
      // Filter out resolution tokens like 1920_1080 or 1280_720
      if (
        fromNum > 0 &&
        fromNum <= 999 &&
        toNum > 0 &&
        toNum <= 999 &&
        !(fromNum >= 720 && toNum >= 480)
      ) {
        return {
          fromIndex: fromNum - 1,
          toIndex: toNum - 1,
        };
      }
    }

    // 2. Matches "slide_01", "01_intro", "transition_2", "انتقال_1"
    const prefixMatch = name.match(
      /^(?:slide_?|شريحة_?|transition_?|انتقال_?)?(\d+)/i
    );
    if (prefixMatch) {
      const num = parseInt(prefixMatch[1], 10);
      if (num > 0 && num <= 999) {
        return { fromIndex: num - 1, toIndex: num };
      }
    }

    // 3. First standalone number
    const standaloneMatch = name.match(/\b(\d+)\b/);
    if (standaloneMatch) {
      const num = parseInt(standaloneMatch[1], 10);
      if (num > 0 && num <= 999) {
        return { fromIndex: num - 1, toIndex: num };
      }
    }

    return null;
  }

  static extractSlideIndexFromFilename(name: string): number | null {
    const parsed = SmartPairer.parseIndicesFromFilename(name);
    return parsed ? parsed.fromIndex : null;
  }

  static normalizeCuePoints(cueTimesSec: number[], durationSec: number): number[] {
    const duration = durationSec > 0 ? durationSec : 1;

    const filtered = (Array.isArray(cueTimesSec) ? cueTimesSec : [])
      .filter((t) => typeof t === 'number' && Number.isFinite(t))
      .map((t) => Math.min(duration, Math.max(0, t)))
      .sort((a, b) => a - b);

    const deduplicated: number[] = [];
    for (const t of filtered) {
      const last = deduplicated[deduplicated.length - 1];
      if (last === undefined || Math.abs(t - last) >= 0.08) {
        deduplicated.push(t);
      }
    }

    if (deduplicated.length === 0) {
      return [0, duration];
    }
    if (deduplicated.length === 1) {
      const t = deduplicated[0];
      if (t < duration * 0.5) {
        return [t, duration];
      }
      return [0, t];
    }

    return deduplicated;
  }

  static async buildSlidesFromVideoCuePoints(
    videoAsset: MediaAsset,
    cueTimesSec: number[],
    defaultFallback: FallbackTransitionStyle = 'crossfade'
  ): Promise<SlideNode[]> {
    const normalized = this.normalizeCuePoints(cueTimesSec, videoAsset.durationSec || 4);

    const slides: SlideNode[] = [];
    for (let i = 0; i < normalized.length; i++) {
      const t = normalized[i];
      const frameAsset = await FrameExtractor.extractFrameAtTimeAsSlideAsset(
        videoAsset,
        t,
        `توقف_${i + 1}_${t.toFixed(1)}s.png`
      );
      const slide = createSlideNode(frameAsset, i, defaultFallback);
      slide.title = `مرحلة توقف ${i + 1} (${t.toFixed(2)}s)`;

      if (i < normalized.length - 1) {
        slide.transitionToNext.videoAsset = videoAsset;
        slide.transitionToNext.startTimeSec = normalized[i];
        slide.transitionToNext.endTimeSec = normalized[i + 1];
      }

      slides.push(slide);
    }

    return slides;
  }
}
