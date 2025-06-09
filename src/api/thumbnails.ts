import { getBearerToken, validateJWT } from '../auth';
import { respondWithJSON } from './json';
import { getVideo, updateVideo } from '../db/videos';
import type { ApiConfig } from '../config';
import type { BunRequest } from 'bun';
import { BadRequestError, NotFoundError, UserForbiddenError } from './errors';
import path from 'path';
import { randomBytes } from 'crypto';

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError('Invalid video ID');
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log('uploading thumbnail for video', videoId, 'by user', userID);

  // TODO: implement the upload here
  const formData = await req.formData();
  const file = formData.get('thumbnail');
  if (!(file instanceof File)) {
    throw new BadRequestError('Thumbnail file missing');
  }
  const MAX_UPLOAD_SIZE = 10 << 20;
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError('File size too big');
  }
  const mediaType = file.type;

  if (mediaType != 'image/jpeg' && mediaType != 'image/png') {
    throw new BadRequestError('Only jpeg/png are allowed');
  }

  const ext = mediaType.split('image/')[1];

  const imageData = await file.arrayBuffer();
  const random = randomBytes(32).toString('base64url');

  const filePath = `${random}.${ext}`;

  Bun.write(path.join(cfg.assetsRoot, filePath), imageData);

  const metadata = getVideo(cfg.db, videoId);
  if (!metadata) {
    throw new NotFoundError('No video exists with that ID');
  }
  if (metadata?.userID != userID) {
    throw new UserForbiddenError('Not your video');
  }

  const thumbnailURL = `http://localhost:${cfg.port}/assets/${filePath}`;
  metadata.thumbnailURL = thumbnailURL;

  updateVideo(cfg.db, metadata);

  return respondWithJSON(200, metadata);
}
