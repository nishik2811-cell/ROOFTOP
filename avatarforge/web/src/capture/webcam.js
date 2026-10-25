// Webcam capture with MediaPipe Face Landmarker and Pose Landmarker, all in the browser.
import { FaceLandmarker, FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { averageLandmarks, landmarksToPatch } from './ratios.js';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

let models;
async function loadModels() {
  models ??= (async () => {
    const files = await FilesetResolver.forVisionTasks(WASM);
    const [face, pose] = await Promise.all([
      FaceLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: FACE_MODEL }, runningMode: 'VIDEO', numFaces: 1 }),
      PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: POSE_MODEL }, runningMode: 'VIDEO', numPoses: 1 }),
    ]);
    return { face, pose };
  })();
  return models;
}

/**
 * Opens the camera into `video`, measures ~20 frames and returns
 * { patch, faceFound, bodyFound }. The camera is stopped afterwards.
 */
export async function measureFromWebcam(video, onStatus = () => {}) {
  onStatus('Starting camera…');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
  try {
    video.srcObject = stream;
    await video.play();
    onStatus('Loading MediaPipe models…');
    const { face, pose } = await loadModels();
    onStatus('Hold still and look at the camera…');
    const faces = [];
    const poses = [];
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const t = performance.now();
      faces.push(face.detectForVideo(video, t).faceLandmarks?.[0] ?? null);
      poses.push(pose.detectForVideo(video, t + 0.5).landmarks?.[0] ?? null);
    }
    const aspect = video.videoWidth / video.videoHeight || 4 / 3;
    const f = averageLandmarks(faces);
    const p = averageLandmarks(poses);
    const patch = landmarksToPatch(f, p, aspect);
    return { patch, faceFound: !!f, bodyFound: 'body.shoulderWidth' in patch };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }
}
