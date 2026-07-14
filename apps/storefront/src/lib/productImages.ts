export interface ProductDisplayImage {
  id: string;
  url: string;
  thumbnailUrl?: string;
  altText?: string;
  sortOrder: number;
  isPrimary: boolean;
}

export interface ProductImageSource {
  photos?: ProductDisplayImage[];
  images?: ProductDisplayImage[];
}

export function sortedProductImages(source: ProductImageSource): ProductDisplayImage[] {
  const preferred = source.photos && source.photos.length > 0 ? source.photos : source.images ?? [];
  return [...preferred].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return a.sortOrder - b.sortOrder;
  });
}

export function primaryProductImage(source: ProductImageSource): ProductDisplayImage | undefined {
  return sortedProductImages(source)[0];
}

export function productThumbnailUrl(image: ProductDisplayImage): string {
  return image.thumbnailUrl ?? image.url;
}
