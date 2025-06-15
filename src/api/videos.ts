import { randomBytes, randomUUID } from 'crypto';
import { respondWithJSON } from './json';

import { type ApiConfig } from '../config';
import type { BunRequest } from 'bun';
import { BadRequestError, NotFoundError, UserForbiddenError } from './errors';
import { getBearerToken, validateJWT } from '../auth';
import { getVideo, updateVideo } from '../db/videos';
import path from 'path';

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_SIZE = 1 << 30;

  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError('Invalid video ID');
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log('uploading video for video', videoId, 'by user', userID);

  const metadata = getVideo(cfg.db, videoId);
  if (!metadata) {
    throw new NotFoundError('No video exists with that ID');
  }
  if (metadata?.userID != userID) {
    throw new UserForbiddenError('Not your video');
  }

  const formData = await req.formData();
  const file = formData.get('video');

  if (!(file instanceof File)) {
    throw new BadRequestError('Video file missing');
  }

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError('File size too big');
  }

  if (file.type != 'video/mp4') {
    throw new BadRequestError('Invalid video format');
  }

  const ext = file.type.split('video/')[1];

  const videoData = await file.arrayBuffer();
  const random = randomBytes(32).toString('base64url');

  let fileName = `${random}.${ext}`;

  const filePath = path.join(cfg.assetsRoot, fileName);

  await Bun.write(filePath, videoData);
  const ratio = await getVideoAspectRatio(filePath);

  const processedFilePath = await processVideoForFastStart(filePath);
  if (!processedFilePath) {
    // write file to local file storage temporarily
    console.error('could not process video for fast start');
    return;
  }

  fileName = ratio + '/' + fileName;

  // create file on s3, and then write to it.
  const s3File = cfg.s3Client.file(fileName);
  s3File.write(Bun.file(processedFilePath), { type: file.type });

  metadata.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${fileName}`;

  // delete temp file(s)
  Bun.file(filePath).delete();
  Bun.file(processedFilePath).delete();

  updateVideo(cfg.db, metadata);

  return respondWithJSON(200, null);
}

async function getVideoAspectRatio(filePath: string) {
  const nineSixteenthsRatio = 9 / 16;
  const sixteenNinthsRatio = 16 / 9;
  const tolerance = 0.001;

  const proc = Bun.spawn(
    [
      'ffprobe',
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'json',
      filePath,
    ],
    {
      stdout: 'pipe',
      stderr: 'inherit',
    }
  );

  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const exited = await proc.exited;
  if (exited !== 0) {
    console.log('error getting video aspect ratio');
    return;
  }

  if (err) {
    console.log(err);
    return;
  }

  const parsed = JSON.parse(out);

  const width = parsed.streams[0].width;
  const height = parsed.streams[0].height;

  const aspectRatio = width / height;

  let ratio = 'other';

  if (Math.abs(aspectRatio - nineSixteenthsRatio) < tolerance) {
    ratio = 'portrait';
  } else if (Math.abs(aspectRatio - sixteenNinthsRatio) < tolerance) {
    ratio = 'landscape';
  }

  return ratio;
}

async function processVideoForFastStart(inputFilePath: string) {
  const [nameOfFile, ext] = inputFilePath.split('.');
  const processed = nameOfFile + '.processed';
  const outputFilePath = processed + '.' + ext;

  const proc = Bun.spawn(
    [
      'ffmpeg',
      '-i',
      inputFilePath,
      '-movflags',
      'faststart',
      '-map_metadata',
      '0',
      '-codec',
      'copy',
      '-f',
      'mp4',
      outputFilePath,
    ],
    {
      stdout: 'pipe',
      stderr: 'inherit',
    }
  );

  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const exited = await proc.exited;
  if (exited !== 0) {
    console.log('error getting video aspect ratio');
    return;
  }

  if (err) {
    console.log(err);
    return;
  }

  return outputFilePath;
}
