// Shared thumbnail picker. Every post that has ANY visual — a native photo, a
// video/GIF (its poster frame), or an outbound link/article (its OG card image)
// — should show a thumbnail so the operator recognizes it without opening X.
// Priority mirrors what best represents the post visually.

export interface ThumbSource {
  media_type: string;
  media_urls?: string[] | null;
  preview_image_url?: string | null;
  link_image_url?: string | null;
}

// media_urls can also contain the mp4 rendition for videos — never a thumbnail.
function firstImage(urls?: string[] | null): string | null {
  return (urls ?? []).find((u) => /^https?:\/\//i.test(u) && !/\.mp4(\?|$)/i.test(u)) ?? null;
}

export function pickThumb(p: ThumbSource): string | null {
  const photo = firstImage(p.media_urls);
  if (p.media_type === "photo" && photo) return photo;
  if ((p.media_type === "video" || p.media_type === "animated_gif") && p.preview_image_url) {
    return p.preview_image_url;
  }
  // Fallbacks: any native image, the video poster, then the link/article card.
  return photo || p.preview_image_url || p.link_image_url || null;
}
