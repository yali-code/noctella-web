"use client";

import { useState } from "react";
import { productThumbnailUrl, sortedProductImages } from "@/lib/productImages";
import type { PublicProductImage } from "@/lib/types";

export function ProductGallery({ images, title }: { images: PublicProductImage[]; title: string }) {
  const sorted = sortedProductImages({ images });
  const [activeIndex, setActiveIndex] = useState(0);
  const [zoomed, setZoomed] = useState(false);

  const active = sorted[activeIndex];

  if (sorted.length === 0) {
    return (
      <div
        style={{
          width: "100%",
          aspectRatio: "1 / 1",
          background: "var(--noctella-night-navy)",
          border: "1px solid var(--noctella-antique-gold)",
          borderRadius: 4,
        }}
      />
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setZoomed(true)}
        aria-label={`Zoom image: ${active.altText || title}`}
        style={{
          display: "block",
          width: "100%",
          padding: 0,
          border: "1px solid var(--noctella-antique-gold)",
          borderRadius: 4,
          background: "none",
          cursor: "zoom-in",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={active.url}
          alt={active.altText || title}
          style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", borderRadius: 4 }}
        />
      </button>

      {sorted.length > 1 && (
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          {sorted.map((img, i) => (
            <button
              key={img.id}
              type="button"
              onClick={() => setActiveIndex(i)}
              aria-label={`View image ${i + 1} of ${sorted.length}`}
              aria-current={i === activeIndex}
              style={{
                padding: 0,
                border:
                  i === activeIndex
                    ? "2px solid var(--noctella-bright-star-gold)"
                    : "1px solid var(--noctella-aged-bronze)",
                borderRadius: 4,
                cursor: "pointer",
                background: "none",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={productThumbnailUrl(img)}
                alt={img.altText || `${title} thumbnail ${i + 1}`}
                style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 3 }}
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
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(11, 18, 32, 0.92)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
            cursor: "zoom-out",
            padding: 24,
          }}
        >
          <button
            type="button"
            onClick={() => setZoomed(false)}
            aria-label="Close enlarged image"
            style={{
              position: "absolute",
              top: 24,
              right: 24,
              background: "none",
              border: "1px solid var(--noctella-antique-gold)",
              color: "var(--noctella-ivory)",
              borderRadius: 4,
              padding: "6px 12px",
              cursor: "pointer",
            }}
          >
            Close
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={active.url}
            alt={active.altText || title}
            style={{ maxWidth: "90vw", maxHeight: "90vh", objectFit: "contain" }}
          />
        </div>
      )}
    </div>
  );
}
