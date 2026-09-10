"use client";

import { useEffect, useRef, useState } from "react";
import { resolveApiAssetUrl } from "@/lib/api";
import { productThumbnailUrl, sortedProductImages } from "@/lib/productImages";
import type { PublicProductImage } from "@/lib/types";

export function ProductGallery({ images, title }: { images: PublicProductImage[]; title: string }) {
  const sorted = sortedProductImages({ images });
  const [activeIndex, setActiveIndex] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const mainButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const active = sorted[activeIndex];

  useEffect(() => {
    if (zoomed) closeButtonRef.current?.focus();
  }, [zoomed]);

  function closeZoom() {
    setZoomed(false);
    window.requestAnimationFrame(() => mainButtonRef.current?.focus());
  }

  function handleDialogKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeZoom();
    } else if (event.key === "Tab") {
      event.preventDefault();
      closeButtonRef.current?.focus();
    }
  }

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
        ref={mainButtonRef}
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
          onClick={(event) => { if (event.target === event.currentTarget) closeZoom(); }}
          onKeyDown={handleDialogKeyDown}
          className="sf-pdp-gallery__dialog"
        >
          <button
            ref={closeButtonRef}
            type="button"
            onClick={closeZoom}
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
