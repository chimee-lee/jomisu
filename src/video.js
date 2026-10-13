// src/video.js
// Samples frames from the first seconds of a video, entirely in the browser.
// Nothing is uploaded. The first frame doubles as the still image we save.

// Resolve when `eventName` fires on `target`; reject on error or timeout.
function waitFor(target, eventName, ms = 8000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(eventName, ok);
      target.removeEventListener("error", fail);
    };
    const ok = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error("video error")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("video timeout")); }, ms);
    target.addEventListener(eventName, ok);
    target.addEventListener("error", fail);
  });
}

/**
 * @param {File} file  a video file
 * @returns {Promise<string[]>} JPEG data URLs, spread across the first `maxSeconds`
 */
export async function extractVideoFrames(file, { maxSeconds = 5, count = 5, maxWidth = 640, quality = 0.6 } = {}) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true; // needed on iPhone
  video.preload = "auto";
  video.src = url;
  try {
    await waitFor(video, "loadeddata");
    const limit = Math.min(maxSeconds, video.duration || maxSeconds);
    const scale = Math.min(1, maxWidth / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext("2d");
    const frames = [];
    for (let i = 0; i < count; i++) {
      // Spread the frames across the first `limit` seconds, staying just inside the end.
      const t = Math.min((limit * i) / count + 0.05, Math.max(limit - 0.05, 0));
      const seeked = waitFor(video, "seeked"); // listen before seeking
      video.currentTime = t;
      await seeked;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL("image/jpeg", quality));
    }
    return frames;
  } finally {
    URL.revokeObjectURL(url);
  }
}
