import PQueue from "p-queue";

// Single-concurrency queue so we don't OOM the VPS processing two large videos at once
export const processingQueue = new PQueue({ concurrency: 1 });
