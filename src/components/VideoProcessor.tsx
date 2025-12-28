// NOTE: Ensure @ffmpeg/core is installed (`npm install @ffmpeg/core`) before using asset imports
import { FFmpeg } from '@ffmpeg/ffmpeg';
// Import FFmpeg core assets via package exports and Vite URL loader
import coreJsUrl from '@ffmpeg/core?url';
import coreWasmUrl from '@ffmpeg/core/wasm?url';
import type { Photo, VideoSettings, CreateVideoParams } from '../types';
import { createVideoOptimizedImage } from '../utils/imageOptimization';

class VideoProcessor {
  async createVideo(params: CreateVideoParams): Promise<Blob> {
    const { photos, audio, settings, onProgress } = params;
    onProgress(0);

    const ffmpeg = new FFmpeg();

    // Add logging for debugging
    ffmpeg.on('log', ({ message }) => {
      console.log('FFmpeg log:', message);
    });

    // Progress listener: ratio 0 to 1 -> map to 70-95% and cap at 95%
    ffmpeg.on('progress', ({ progress }: { progress: number }) => {
      const mappedProgress = Math.floor(70 + progress * 25);
      onProgress(Math.min(mappedProgress, 95)); // Cap at 95% to prevent overflow
    });

    try {
      // Load FFmpeg core from local module assets with fallback options
      console.log('Loading FFmpeg with core URLs:', { coreJsUrl, coreWasmUrl });

      await ffmpeg.load({
        coreURL: coreJsUrl,
        wasmURL: coreWasmUrl,
        // Add workerURL if needed for better compatibility
      });

      console.log('FFmpeg loaded successfully');
      onProgress(10);

      // Write optimized photos/videos to virtual FS for faster processing
      for (let i = 0; i < photos.length; i++) {
        const media = photos[i];
        console.log(`Processing ${media.type} ${i}: ${media.name}, file size: ${media.file.size} bytes`);

        try {
          if (media.type === 'image') {
            // Optimize image for video processing to reduce FFmpeg load
            const optimizedBlob = await createVideoOptimizedImage(media.file, 1920);
            const fileData = new Uint8Array(await optimizedBlob.arrayBuffer());
            console.log(`Optimized photo ${i}: ${fileData.length} bytes (was ${media.file.size})`);

            await ffmpeg.writeFile(`media_${i}.jpg`, fileData);
            console.log(`Written optimized media_${i}.jpg, size: ${fileData.length} bytes`);
          } else {
            // Handle video file - write directly without optimization for now
            const fileData = new Uint8Array(await media.file.arrayBuffer());
            const extension = media.file.name.split('.').pop()?.toLowerCase() || 'mp4';
            await ffmpeg.writeFile(`media_${i}.${extension}`, fileData);
            console.log(`Written video media_${i}.${extension}, size: ${fileData.length} bytes`);
          }
        } catch (error) {
          // Fallback to original file if optimization fails
          console.warn(`Processing failed for ${media.type} ${i}, using original:`, error);
          const fileData = new Uint8Array(await media.file.arrayBuffer());
          const extension = media.type === 'image' ? 'jpg' : (media.file.name.split('.').pop()?.toLowerCase() || 'mp4');
          await ffmpeg.writeFile(`media_${i}.${extension}`, fileData);
        }
      }
      onProgress(30);

      // Calculate total duration considering both photos and videos
      const totalDuration = photos.reduce((total, media) => {
        if (media.type === 'video' && media.duration && !settings.applyPhotoDurationToVideos) {
          return total + media.duration;
        } else if (media.type === 'video' && media.duration && settings.applyPhotoDurationToVideos) {
          // When applying photo duration to videos, use the minimum of video duration and photo duration
          return total + Math.min(media.duration, settings.photoDuration);
        } else {
          return total + settings.photoDuration;
        }
      }, 0);
      console.log(`Total video duration: ${totalDuration} seconds`);

      // Process audio if provided
      if (audio) {
        console.log(`Processing audio: ${audio.name}, file size: ${audio.file.size} bytes`);

        // Use arrayBuffer instead of fetchFile
        const audioData = new Uint8Array(await audio.file.arrayBuffer());
        console.log(`Converted audio to array buffer: ${audioData.length} bytes`);

        // Determine if this is a video file that needs audio extraction
        const isVideoFile = audio.file.type.startsWith('video/') ||
          /\.(mp4|mov|avi|mkv|webm|3gp)$/i.test(audio.name);

        const inputFileName = isVideoFile ? 'input_video_for_audio.mp4' : 'input_audio.mp3';
        await ffmpeg.writeFile(inputFileName, audioData);
        console.log(`Written ${isVideoFile ? 'video' : 'audio'} file: ${inputFileName}, size: ${audioData.length} bytes`);

        // Extract audio from video if needed, or process audio directly
        let audioInputName = inputFileName;
        if (isVideoFile) {
          console.log('Extracting audio from video file...');
          try {
            // Optimized audio extraction with faster settings
            await ffmpeg.exec([
              '-i', inputFileName,
              '-vn', // No video
              '-acodec', 'aac',
              '-ar', '44100', // Standard sample rate (was 48000)
              '-ac', '2', // Set to stereo
              '-b:a', '96k', // Lower bitrate for faster processing (was 128k)
              '-threads', '0', // Use all available threads
              'extracted_audio.aac'
            ]);
            audioInputName = 'extracted_audio.aac';

            // Verify audio extraction worked
            const extractedFiles = await ffmpeg.listDir('/');
            const extractedFile = extractedFiles.find(f => f.name === 'extracted_audio.aac');
            console.log('Audio extraction completed. Files:', extractedFiles.map(f => f.name));
            if (!extractedFile) {
              throw new Error('Video file has no audio stream');
            }
          } catch (error) {
            console.warn('Failed to extract audio from video file (likely silent video):', error);
            // Create a silent audio track as fallback for silent videos
            console.log('Creating silent audio track for silent video...');
            await ffmpeg.exec([
              '-f', 'lavfi',
              '-i', `anullsrc=channel_layout=stereo:sample_rate=44100:duration=${totalDuration}`,
              '-c:a', 'aac',
              '-ar', '44100',
              '-ac', '2',
              '-b:a', '96k',
              'extracted_audio.aac'
            ]);
            audioInputName = 'extracted_audio.aac';

            // Verify silent audio creation worked
            const silentFiles = await ffmpeg.listDir('/');
            const silentFile = silentFiles.find(f => f.name === 'extracted_audio.aac');
            if (!silentFile) {
              throw new Error('Failed to create silent audio track for video file');
            }
            console.log('Silent audio track created successfully');
          }
        }

        // Process audio with error handling for silent or corrupted audio files
        try {
          if (!audio.duration || audio.duration <= 0) {
            throw new Error('Audio file has no detectable duration or is silent');
          }

          if (audio.duration < totalDuration) {
            const loopCount = Math.ceil(totalDuration / audio.duration) - 1;
            let audioArgs = [
              '-stream_loop', loopCount.toString(),
              '-i', audioInputName,
              '-t', totalDuration.toString()
            ];

            // Add audio fade effects if enabled
            if (settings.audioFadeInOut) {
              audioArgs.push('-af', `afade=t=in:ss=0:d=1,afade=t=out:st=${totalDuration - 1}:d=1`);
            }

            audioArgs.push(
              '-c:a', 'aac',
              '-ar', '44100', // Match optimized sample rate
              '-ac', '2',     // Ensure stereo output
              '-b:a', '96k',  // Optimized bitrate for speed
              'audio.aac'
            );

            await ffmpeg.exec(audioArgs);
          } else {
            let audioArgs = [
              '-i', audioInputName,
              '-t', totalDuration.toString()
            ];

            // Add audio fade effects if enabled
            if (settings.audioFadeInOut) {
              audioArgs.push('-af', `afade=t=in:ss=0:d=1,afade=t=out:st=${totalDuration - 1}:d=1`);
            }

            audioArgs.push(
              '-c:a', 'aac',
              '-ar', '44100', // Match optimized sample rate
              '-ac', '2',     // Ensure stereo output
              '-b:a', '96k',  // Optimized bitrate for speed
              'audio.aac'
            );

            await ffmpeg.exec(audioArgs);
          }
        } catch (error) {
          console.warn('Failed to process audio file (likely silent or corrupted audio):', error);
          // Create a silent audio track as fallback for silent/corrupted audio files
          console.log('Creating silent audio track for corrupted/silent audio file...');
          await ffmpeg.exec([
            '-f', 'lavfi',
            '-i', `anullsrc=channel_layout=stereo:sample_rate=44100:duration=${totalDuration}`,
            '-c:a', 'aac',
            '-ar', '44100',
            '-ac', '2',
            '-b:a', '96k',
            'audio.aac'
          ]);
          console.log('Silent audio track created as fallback for audio processing');
        }

        // Verify the audio file was created successfully
        const audioFiles = await ffmpeg.listDir('/');
        const audioFile = audioFiles.find(f => f.name === 'audio.aac');
        console.log('Audio processing completed. Files:', audioFiles.map(f => f.name));
        if (!audioFile) {
          throw new Error('Failed to process audio: audio.aac file was not created');
        }

        onProgress(50);
      }      // Create filter complex for video
      const filterComplex = this.buildFilter(photos, settings, audio ? true : false);
      console.log('Filter complex:', filterComplex);
      onProgress(60);

      // Assemble FFmpeg arguments with simpler approach
      const args: string[] = [];

      // Add input files - handle both images and videos with correct durations
      for (let i = 0; i < photos.length; i++) {
        const media = photos[i];
        if (media.type === 'image') {
          args.push('-loop', '1', '-t', settings.photoDuration.toString(), '-i', `media_${i}.jpg`);
        } else {
          // For video files, use their full duration or clip to photo duration based on setting
          const extension = media.file.name.split('.').pop()?.toLowerCase() || 'mp4';
          if (settings.applyPhotoDurationToVideos) {
            args.push('-t', settings.photoDuration.toString(), '-i', `media_${i}.${extension}`);
          } else {
            args.push('-i', `media_${i}.${extension}`);
          }
        }
      }

      if (audio) {
        args.push('-i', 'audio.aac');
      }

      // Add filter complex
      args.push('-filter_complex', filterComplex);

      // Map video output
      args.push('-map', '[outv]');

      // Handle audio mapping based on video content and settings
      const hasVideoContent = photos.some(media => media.type === 'video');

      if (audio && hasVideoContent && settings.keepOriginalVideoAudio) {
        // Mix background audio with video audio - use filter complex output
        args.push('-map', '[outa]');
        args.push('-c:a', 'aac');
        args.push('-b:a', '128k');
      } else if (audio) {
        // Only background audio
        args.push('-map', `${photos.length}:a`);
        args.push('-c:a', 'aac');
        args.push('-b:a', '96k'); // Optimized audio bitrate for speed
      } else if (hasVideoContent && settings.keepOriginalVideoAudio) {
        // Only video audio (no background music)
        if (photos.length === 1) {
          // Single video - map directly from input (no filter complex audio)
          args.push('-map', '0:a?');
          args.push('-c:a', 'aac');
          args.push('-b:a', '128k');
        } else {
          // Multiple videos - use filter complex output
          args.push('-map', '[outa]');
          args.push('-c:a', 'aac');
          args.push('-b:a', '128k');
        }
      } else {
        // No audio
        args.push('-an');
      }

      // Video encoding options - optimized for speed
      const hasVideos = photos.some(media => media.type === 'video');
      const outputFrameRate = hasVideos ? 30 : 24; // Use 30fps if videos present, 24fps for photos only

      args.push(
        '-c:v', 'libx264',
        '-preset', 'ultrafast', // Fastest encoding preset
        '-tune', 'fastdecode',   // Optimize for fast decoding
        '-crf', '23',            // Better quality with reasonable speed
        '-pix_fmt', 'yuv420p',
        '-color_range', 'tv',    // Limited range (16-235) to prevent oversaturation
        '-colorspace', 'bt709',  // Standard HD color space for proper color reproduction
        '-r', outputFrameRate.toString(), // Dynamic frame rate based on content
        '-threads', '0',         // Use all available CPU threads
        '-movflags', '+faststart',
        '-shortest',             // Stop at shortest input
        'output.mp4'
      );

      console.log('FFmpeg command:', args.join(' '));
      // Let FFmpeg progress listener handle the progress from here

      // Run encoding
      await ffmpeg.exec(args);
      onProgress(95);

      // Check if output file exists and has content
      const files = await ffmpeg.listDir('/');
      console.log('Files in FFmpeg filesystem:', files);

      const outputFile = files.find(f => f.name === 'output.mp4');
      if (!outputFile) {
        throw new Error('Failed to generate video: output.mp4 file was not created');
      }

      // Read output file and return blob
      const output = await ffmpeg.readFile('output.mp4');

      console.log('FFmpeg output type:', typeof output);
      console.log('FFmpeg output constructor:', output.constructor.name);
      console.log('FFmpeg output length:', (output as Uint8Array).length);

      // Ensure output is a Uint8Array and has content
      if (!output) {
        throw new Error('Failed to generate video: No output from FFmpeg');
      }

      // FFmpeg readFile returns Uint8Array, but let's ensure it's the right type
      const uint8Array = output as Uint8Array;

      if (uint8Array.length === 0) {
        throw new Error('Failed to generate video: Output file is empty (0 bytes)');
      } console.log(`Generated video size: ${uint8Array.length} bytes`);

      // Verify it looks like an MP4 file (should start with specific bytes)
      const mp4Header = uint8Array.slice(0, 8);
      console.log('MP4 header bytes:', Array.from(mp4Header).map(b => b.toString(16).padStart(2, '0')).join(' '));

      onProgress(100);

      // Create blob with proper video MIME type
      const blob = new Blob([new Uint8Array(uint8Array)], { type: 'video/mp4' });
      console.log('Created blob size:', blob.size);

      return blob;

    } catch (error) {
      console.error('Error in video processing:', error);
      throw error;
    } finally {
      // Clean up FFmpeg instance
      try {
        ffmpeg.terminate();
      } catch (e) {
        console.warn('Error terminating FFmpeg:', e);
      }
    }
  }

  private buildFilter(photos: Photo[], settings: VideoSettings, hasBackgroundAudio?: boolean): string {
    const { photoDuration, fadeInOut, fadePosition } = settings;
    const fadeDuration = 0.5;
    let filter = '';

    // Validate inputs
    if (photos.length === 0) {
      throw new Error('No media provided for video generation');
    }

    // Scale and prepare each media stream (photos/videos) to 1080p with optimization
    // Handle different durations for images vs videos
    const hasVideos = photos.some(media => media.type === 'video');
    const frameRate = hasVideos ? 30 : 24; // Use 30fps if videos present, 24fps for photos only

    photos.forEach((media, i) => {
      if (media.type === 'image') {
        // Images use photoDuration and need setpts for timing
        filter += `[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setpts=PTS-STARTPTS,fps=${frameRate},setsar=1[v${i}];`;
      } else {
        // Videos use their natural duration and timing
        filter += `[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=${frameRate},setsar=1[v${i}];`;
      }
    });

    // Calculate total duration for fade timing
    const totalVideoDuration = photos.reduce((total, media) => {
      if (media.type === 'video' && media.duration && !settings.applyPhotoDurationToVideos) {
        return total + media.duration;
      } else if (media.type === 'video' && media.duration && settings.applyPhotoDurationToVideos) {
        // When applying photo duration to videos, use the minimum of video duration and photo duration
        return total + Math.min(media.duration, photoDuration);
      } else {
        return total + photoDuration;
      }
    }, 0);

    if (!fadeInOut) {
      filter += photos.map((_, i) => `[v${i}]`).join('') + `concat=n=${photos.length}:v=1:a=0[outv]`;

      // Handle audio if video audio should be preserved
      if (hasVideos && settings.keepOriginalVideoAudio) {
        filter += this.buildAudioFilter(photos, settings, hasBackgroundAudio || false, photos.length);
      }

      return filter;
    }

    if (fadePosition === 'beginning-end' && photos.length > 1) {
      // First photo: fade in only
      filter += `[v0]fade=t=in:st=0:d=${fadeDuration}[v0f];`;

      // Middle photos: no fade effects
      for (let i = 1; i < photos.length - 1; i++) {
        filter += `[v${i}]setpts=PTS-STARTPTS[v${i}f];`;
      }

      // Last photo: no fade out here, we'll do it after concat
      const last = photos.length - 1;
      filter += `[v${last}]setpts=PTS-STARTPTS[v${last}f];`;

      // Concat all photos first, then apply final fade out to black
      filter += photos.map((_, i) => `[v${i}f]`).join('') + `concat=n=${photos.length}:v=1:a=0[concat_out];`;
      filter += `[concat_out]fade=t=out:st=${totalVideoDuration - fadeDuration}:d=${fadeDuration}[outv]`;

      // Handle audio if video audio should be preserved
      if (hasVideos && settings.keepOriginalVideoAudio) {
        filter += this.buildAudioFilter(photos, settings, hasBackgroundAudio || false, photos.length);
      }

      return filter;
    }

    // Single media case
    if (photos.length === 1) {
      const media = photos[0];
      const mediaDuration = (media.type === 'video' && media.duration && !settings.applyPhotoDurationToVideos)
        ? media.duration
        : (media.type === 'video' && media.duration && settings.applyPhotoDurationToVideos)
          ? Math.min(media.duration, photoDuration)
          : photoDuration;
      filter += `[v0]fade=t=in:st=0:d=${fadeDuration},fade=t=out:st=${mediaDuration - fadeDuration}:d=${fadeDuration}[outv]`;

      // For single video with keepOriginalVideoAudio enabled, always create [outa]
      if (media.type === 'video' && settings.keepOriginalVideoAudio) {
        if (hasBackgroundAudio) {
          // Create a silent audio track as base, then mix with background audio
          filter += `;anullsrc=channel_layout=stereo:sample_rate=44100:duration=${mediaDuration}[video_silence];[video_silence][${photos.length}:a]amix=inputs=2:duration=shortest[outa]`;
        }
        // For single video without background audio, don't create [outa] in filter - handle in mapping
      }

      return filter;
    }

    // Fade throughout (multiple media)
    // Handle individual fade timings for mixed media
    let currentTime = 0;

    // First media: fade in and fade out
    const firstMedia = photos[0];
    const firstDuration = (firstMedia.type === 'video' && firstMedia.duration && !settings.applyPhotoDurationToVideos)
      ? firstMedia.duration
      : (firstMedia.type === 'video' && firstMedia.duration && settings.applyPhotoDurationToVideos)
        ? Math.min(firstMedia.duration, photoDuration)
        : photoDuration;
    filter += `[v0]fade=t=in:st=0:d=${fadeDuration},fade=t=out:st=${firstDuration - fadeDuration}:d=${fadeDuration}[v0f];`;
    currentTime += firstDuration;

    // Middle media: fade in and fade out
    for (let i = 1; i < photos.length - 1; i++) {
      const media = photos[i];
      const mediaDuration = (media.type === 'video' && media.duration && !settings.applyPhotoDurationToVideos)
        ? media.duration
        : (media.type === 'video' && media.duration && settings.applyPhotoDurationToVideos)
          ? Math.min(media.duration, photoDuration)
          : photoDuration;
      filter += `[v${i}]fade=t=in:st=0:d=${fadeDuration},fade=t=out:st=${mediaDuration - fadeDuration}:d=${fadeDuration}[v${i}f];`;
      currentTime += mediaDuration;
    }

    // Last media: fade in only (we'll add final fade out after concat)
    const last = photos.length - 1;
    filter += `[v${last}]fade=t=in:st=0:d=${fadeDuration}[v${last}f];`;

    // Concat all media first, then apply final fade out to black
    const streams = photos.map((_, i) => `[v${i}f]`).join('');
    filter += streams + `concat=n=${photos.length}:v=1:a=0[concat_out];`;
    filter += `[concat_out]fade=t=out:st=${totalVideoDuration - fadeDuration}:d=${fadeDuration}[outv]`;

    // Handle audio if video audio should be preserved
    if (hasVideos && settings.keepOriginalVideoAudio) {
      filter += this.buildAudioFilter(photos, settings, hasBackgroundAudio || false, photos.length);
    }

    return filter;
  }

  private buildAudioFilter(photos: Photo[], settings: VideoSettings, hasBackgroundAudio: boolean, audioInputIndex: number): string {
    const { photoDuration } = settings;
    let audioFilter = '';
    let audioStreams: string[] = [];

    // Create audio streams with proper timing for each media
    photos.forEach((media, i) => {
      if (media.type === 'video') {
        // For videos, use actual video audio with aresample to ensure consistent format
        // Use aresample to ensure consistent sample rate, with silent fallback if no audio stream
        audioFilter += `[${i}:a]aresample=44100,aformat=channel_layouts=stereo[video_audio${i}];`;
        audioStreams.push(`[video_audio${i}]`);
      } else {
        // For images, create silent audio of photo duration
        audioFilter += `anullsrc=channel_layout=stereo:sample_rate=44100:duration=${photoDuration}[silence${i}];`;
        audioStreams.push(`[silence${i}]`);
      }
    });

    if (audioStreams.length > 0) {
      // Concatenate audio streams to match video timeline
      if (hasBackgroundAudio) {
        audioFilter += `${audioStreams.join('')}concat=n=${photos.length}:v=0:a=1[video_audio];`;
        // Mix the timeline-synced video audio with background audio
        return `;${audioFilter}[video_audio][${audioInputIndex}:a]amix=inputs=2:duration=shortest[outa]`;
      } else {
        // Only video audio with proper timeline - output directly as [outa]
        audioFilter += `${audioStreams.join('')}concat=n=${photos.length}:v=0:a=1[outa];`;
        return `;${audioFilter.slice(0, -1)}`; // Remove the last semicolon
      }
    }

    return '';
  }
}

export default VideoProcessor;