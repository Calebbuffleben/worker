# FFmpeg Transcode Worker

Consumer that processes video jobs from Redis, generates HLS and a thumbnail, uploads to R2, and calls the backend when done.

## When it runs
- Backend enqueues after multipart complete (POST /api/videos/multipart/complete).
- Payload: { videoId, organizationId, assetKey, sourcePath } into queue "video-transcode".
- This process listens and runs jobs as they arrive.

## What it does
1. Download original from R2 to temp
2. ffprobe metadata
3. FFmpeg → HLS (MVP single variant) under hls/
   - Step-by-step (current MVP):
     1) Probe input (duration, dimensions, fps)
     2) Choose single rendition (default 1280x720 ~3000kbps, AAC 128kbps)
     3) Transcode flags (example):
        - `-vcodec libx264 -profile:v high -level 4.1`
        - `-preset veryfast` (tune later)
        - `-crf 21` (or `-b:v 3000k` if CBR)
        - `-acodec aac -b:a 128k`
        - Keyframe alignment: `-sc_threshold 0 -g 48 -keyint_min 48`
        - HLS: `-hls_time 6 -hls_playlist_type vod -hls_flags independent_segments`
     4) Outputs:
        - `hls/master.m3u8` (single-variant playlist)
        - `hls/segment_*.ts` (or fMP4 later)
   - To cover “all needed functions” next:
     - Multi-rendition ladder (e.g., 1080p/720p/480p/360p)
     - Compose master.m3u8 listing all variants with `BANDWIDTH`, `RESOLUTION`, `FRAME-RATE`
     - Optional CMAF/fMP4 output for broader device support
     - Subtitles/captions ingest (VTT) and mapping into the playlists
     - DRM/key delivery (if required) or AES-128 HLS with key endpoint
4. Upload hls/ recursively to R2 at <assetKey>/hls/
5. Extract 1 thumbnail → <assetKey>/thumbs/0001.jpg
6. POST {BACKEND_API_URL}/api/videos/transcode/callback with { videoId, organizationId, assetKey, hlsMasterPath, durationSeconds }

## Env vars
- REDIS_URL, QUEUE_NAME (default video-transcode)
- R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
- BACKEND_API_URL, BACKEND_API_TOKEN (optional)

## Run
- In worker/:
  - npm install
  - npm run dev (or npm run build && npm start)

## E2E test
1) Start backend + set envs (Redis, R2)
2) Start worker
3) Upload short video (multipart) from frontend
4) Check R2: org/<orgId>/video/<videoId>/hls/master.m3u8 and thumbs/0001.jpg
5) Backend Video should be READY with playbackHlsPath

## Notes
- HLS single 720p variant for now; extend ladder later
- If no jobs processed, confirm REDIS_URL and that backend enqueued TRANSCODE_VIDEO