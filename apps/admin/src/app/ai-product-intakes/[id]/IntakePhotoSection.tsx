"use client";

import { AiProductIntakeStatus, type AiIntakePhoto } from "@noctella/shared";
import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { aiProductIntakesApi } from "@/lib/aiProductIntakes";

interface Props {
  intakeId: string;
  intakeStatus: AiProductIntakeStatus;
  photos: AiIntakePhoto[];
  onPhotosChanged: () => Promise<AiIntakePhoto[]>;
}

/**
 * Sprint 97: staged-photo gallery, upload, and delete. Renders each photo via
 * an authenticated credentialed fetch -> Blob -> object URL (no static/public
 * URL exists for staged photos) - object URLs are revoked whenever the photo
 * list changes and on unmount, never left dangling.
 */
export function IntakePhotoSection({ intakeId, intakeStatus, photos, onPhotosChanged }: Props) {
  const [objectUrls, setObjectUrls] = useState<Record<string, string>>({});
  const [imageErrors, setImageErrors] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const created: Record<string, string> = {};
    setImageErrors({});
    (async () => {
      for (const photo of photos) {
        try {
          const blob = await aiProductIntakesApi.fetchPhotoContent(intakeId, photo.id);
          if (cancelled) return;
          created[photo.id] = URL.createObjectURL(blob);
          setObjectUrls((prev) => ({ ...prev, [photo.id]: created[photo.id] }));
        } catch (err) {
          if (!cancelled) {
            setImageErrors((prev) => ({ ...prev, [photo.id]: err instanceof ApiError ? err.message : "Failed to load photo" }));
          }
        }
      }
    })();
    return () => {
      cancelled = true;
      Object.values(created).forEach((url) => URL.revokeObjectURL(url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intakeId, photos]);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      await aiProductIntakesApi.uploadPhoto(intakeId, file);
      setFile(null);
      await onPhotosChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to upload photo");
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(photoId: string) {
    setDeleting(true);
    setError(null);
    try {
      await aiProductIntakesApi.deletePhoto(intakeId, photoId);
      setConfirmDeleteId(null);
      await onPhotosChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete photo");
    } finally {
      setDeleting(false);
    }
  }

  const canUpload = intakeStatus === AiProductIntakeStatus.Open;
  const canDelete = intakeStatus === AiProductIntakeStatus.Open || intakeStatus === AiProductIntakeStatus.Cancelled;

  return (
    <div className="noctella-panel" style={{ padding: 20, marginBottom: 20 }}>
      <h3 style={{ marginTop: 0 }}>Staged Photos</h3>
      {intakeStatus === AiProductIntakeStatus.Cancelled && (
        <p style={{ fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
          This intake is cancelled. Staged photos may still be removed, but no further proposal or apply actions are available.
        </p>
      )}
      {error && <p style={{ color: "#c86a6a" }}>{error}</p>}

      {canUpload && (
        <form onSubmit={handleUpload} style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
          <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button type="submit" disabled={!file || uploading} style={primaryButtonStyle}>
            {uploading ? "Uploading..." : "Upload photo"}
          </button>
        </form>
      )}

      {photos.length === 0 && <p style={{ color: "var(--noctella-aged-bronze)", fontSize: 13 }}>No staged photos yet.</p>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 12 }}>
        {photos.map((photo) => (
          <div key={photo.id} className="noctella-panel" style={{ padding: 8 }}>
            {objectUrls[photo.id] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={objectUrls[photo.id]}
                alt={photo.originalFilename}
                style={{ width: "100%", height: 100, objectFit: "cover", borderRadius: 4 }}
              />
            ) : imageErrors[photo.id] ? (
              <p style={{ fontSize: 11, color: "#c86a6a" }}>{imageErrors[photo.id]}</p>
            ) : (
              <div style={{ width: "100%", height: 100, background: "var(--noctella-night-navy)", borderRadius: 4 }} />
            )}
            {canDelete &&
              (confirmDeleteId === photo.id ? (
                <div style={{ marginTop: 6 }}>
                  <p style={{ fontSize: 11 }}>Delete this photo?</p>
                  <button onClick={() => handleDelete(photo.id)} disabled={deleting} style={{ ...secondaryButtonStyle, fontSize: 11 }}>
                    {deleting ? "Deleting..." : "Confirm Delete"}
                  </button>{" "}
                  <button onClick={() => setConfirmDeleteId(null)} style={{ ...secondaryButtonStyle, fontSize: 11 }}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button onClick={() => setConfirmDeleteId(photo.id)} style={{ ...secondaryButtonStyle, fontSize: 11, marginTop: 6 }}>
                  Delete
                </button>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

const primaryButtonStyle: React.CSSProperties = {
  padding: "10px 18px",
  background: "var(--noctella-antique-gold)",
  color: "var(--noctella-night-navy)",
  border: "none",
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: "6px 10px",
  background: "transparent",
  color: "var(--noctella-ivory)",
  border: "1px solid var(--noctella-aged-bronze)",
  borderRadius: 4,
  cursor: "pointer",
};
