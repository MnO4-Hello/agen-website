/**
 * 上传前的本地压缩。
 *
 * 为什么需要：留言板的入口对游客开放，而手机直出的照片普遍 3–8 MB。不压的话
 *   · 上传慢到用户以为卡死（后端上限 5 MB，超了直接 413）；
 *   · 一页四条带图留言就是几十 MB，谁都打不开。
 *
 * 规则（宁可不压，也不能压坏）：
 *   · **GIF 原样放行**——canvas 只留第一帧，表情包会变成静止图；
 *   · 本来就小（< 700 KB）的图不碰，二次编码只会掉画质；
 *   · 最长边超过 1600 才缩，留言里的图不需要打印级分辨率；
 *   · 优先 WebP（体积约为 JPEG 的六成），不支持则退回 JPEG；
 *   · **任何一步失败都返回原文件**。压缩是优化，不是功能。
 */

const MAX_EDGE = 1600;
const SKIP_BYTES = 700 * 1024;
const QUALITY = 0.85;

function toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, QUALITY);
  });
}

export async function compressImage(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  if (file.size <= SKIP_BYTES) return file;

  let bitmap: ImageBitmap | null = null;
  try {
    // `imageOrientation: 'from-image'`：手机照片的方向存在 EXIF 里，不按它解码会躺倒。
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const edge = Math.max(bitmap.width, bitmap.height);
    const scale = edge > MAX_EDGE ? MAX_EDGE / edge : 1;

    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return file;
    // JPEG 没有透明通道，先铺白底，否则透明区域会变黑。
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);

    const webp = await toBlob(canvas, 'image/webp');
    const blob = webp && webp.size > 0 ? webp : await toBlob(canvas, 'image/jpeg');
    if (!blob) return file;
    // 压完反而更大（小图重编码很常见）就用原图。
    return blob.size >= file.size ? file : blob;
  } catch {
    return file;
  } finally {
    bitmap?.close();
  }
}
