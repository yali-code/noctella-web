"use client";

import { useState } from "react";
import { resolveApiAssetUrl } from "@/lib/api";
import { productThumbnailUrl, sortedProductImages } from "@/lib/productImages";
import type { PublicProductImage } from "@/lib/types";

export function ProductGallery({ images, title }: { images: PublicProductImage[]; title: string }) {
  const sorted = sortedProductImages({ images });
  const [activeIndex, setActiveIndex] = useState(0);
  const [zoomed, setZoomed] = useState(false);

  const active = sorted[activeIndex];

  if (sorted.length === 0) {
    return (
      <div className="sf-pdp-gallery__empty" role="img" aria-label={`${title}: image unavailable`}>
        Image unavailable
      </div>
    );
  }

  return (
    <div className="sf-pdp-gallery">
      <button
        type="button"
        onClick={() => setZoomed(true)}
        aria-label={`Zoom image: ${active.altText || title}`}
        className="sf-pdp-gallery__main"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={resolveApiAssetUrl(active.url)}
          alt={active.altText || title}
        />
      </button>

      {sorted.length > 1 && (
        <div className="sf-pdp-gallery__thumbnails">
          {sorted.map((img, i) => (
            <button
              key={img.id}
              type="button"
              onClick={() => setActiveIndex(i)}
              aria-label={`View image ${i + 1} of ${sorted.length}`}
              aria-current={i === activeIndex}
              className="sf-pdp-gallery__thumbnail"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={resolveApiAssetUrl(productThumbnailUrl(img))}
                alt={img.altText || `${title} thumbnail ${i + 1}`}
              />
            </button>
          ))}
        </div>
      )}

      {zoomed && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${title} enlarged image`}
          onClick={() => setZoomed(false)}
          className="sf-pdp-gallery__dialog"
        >
          <button
            type="button"
            onClick={() => setZoomed(false)}
            aria-label="Close enlarged image"
            className="sf-pdp-gallery__close"
          >
            Close
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={resolveApiAssetUrl(active.url)}
            alt={active.altText || title}
            className="sf-pdp-gallery__zoomed-image"
          />
        </div>
      )}
    </div>
  );
}
