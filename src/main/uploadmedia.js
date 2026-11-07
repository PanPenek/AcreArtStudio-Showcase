/**
 * uploadmedia.js: which file a DeviantArt upload sends.
 *
 * A Review card can post its still picture, its animated GIF or its MP4. The renderer names
 * the media by kind + file name only; this turns that into a path inside the library folder
 * (base name only, so a crafted name cannot leave the folder).
 */
const path = require('path');

const MEDIA_DIRS = { gif: 'gifs', video: 'videos' };

function resolveUploadMedia(payload, libraryDir) {
  const p = { ...(payload || {}) };
  const m = p.media;
  delete p.media;
  if (!m) return p;
  const dir = MEDIA_DIRS[m.kind];
  if (!dir) throw new Error(`unknown upload media kind: ${m.kind}`);
  const name = path.basename(String(m.fname || ''));
  if (!name || name === '.' || name === '..') throw new Error('the card names no media file to upload');
  p.filePath = path.join(libraryDir, dir, name);
  return p;
}

module.exports = { resolveUploadMedia, MEDIA_DIRS };
