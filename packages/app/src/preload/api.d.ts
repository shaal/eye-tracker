import type { EyeTrackerApi } from './index.js';

declare global {
  interface Window {
    eyeTracker: EyeTrackerApi;
  }
}

export {};
