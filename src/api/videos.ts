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

  const fileName = `${random}.${ext}`;

  const filePath = path.join(cfg.assetsRoot, fileName);

  // write file to local file storage temporarily
  Bun.write(filePath, videoData);

  // create file on s3, and then write to it.
  const s3File = cfg.s3Client.file(fileName);
  s3File.write(Bun.file(filePath), { type: file.type });

  metadata.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${fileName}`;

  // delete temp file
  Bun.file(filePath).delete();

  updateVideo(cfg.db, metadata);

  return respondWithJSON(200, null);
}
