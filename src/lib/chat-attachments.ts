/**
 * Client helpers for chat image attachments.
 *
 * - Validates type/size (image/*, ≤10MB, ≤10 per message)
 * - Downscales images >2048px on the longest edge before upload
 * - Uploads to the private `chat-attachments` bucket under {userId}/{uuid}.{ext}
 * - Returns the storage paths for the chat stream payload
 */
import { supabase } from "@/integrations/supabase/client";

export const MAX_FILES_PER_MESSAGE = 10;
export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_EDGE_PX = 2048;

export type PendingAttachment = {
  id: string;
  file: File;
  previewUrl: string; // object URL for thumbnail
};

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

export function validateImage(file: File): string | null {
  if (!isImageFile(file)) return "Only images are supported";
  if (file.size > MAX_FILE_BYTES) return "Image exceeds 10 MB";
  return null;
}

export function makePending(file: File): PendingAttachment {
  return {
    id: crypto.randomUUID(),
    file,
    previewUrl: URL.createObjectURL(file),
  };
}

export function revokePending(p: PendingAttachment) {
  try {
    URL.revokeObjectURL(p.previewUrl);
  } catch {
    /* noop */
  }
}

async function downscaleIfNeeded(file: File): Promise<Blob> {
  // Skip non-raster or already-small images
  if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) return file;
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return file;
  const longest = Math.max(bmp.width, bmp.height);
  if (longest <= MAX_EDGE_PX) {
    bmp.close();
    return file;
  }
  const scale = MAX_EDGE_PX / longest;
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bmp.close();
    return file;
  }
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const mime = file.type === "image/png" ? "image/png" : "image/jpeg";
  return await new Promise<Blob>((resolve) => {
    canvas.toBlob((b) => resolve(b ?? file), mime, 0.9);
  });
}

function extFor(file: File): string {
  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  if (file.type === "image/gif") return "gif";
  return "jpg";
}

export async function uploadAttachments(
  pending: PendingAttachment[],
): Promise<string[]> {
  if (pending.length === 0) return [];
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) throw new Error("Not signed in");

  const paths: string[] = [];
  for (const p of pending) {
    const blob = await downscaleIfNeeded(p.file);
    const path = `${userId}/${crypto.randomUUID()}.${extFor(p.file)}`;
    const { error } = await supabase.storage
      .from("chat-attachments")
      .upload(path, blob, {
        contentType: p.file.type || "image/jpeg",
        upsert: false,
      });
    if (error) throw error;
    paths.push(path);
  }
  return paths;
}
