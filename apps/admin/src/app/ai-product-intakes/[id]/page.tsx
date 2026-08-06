"use client";

import { AiProductIntakeStatus, type AiIntakePhoto, type AiIntakeProposalReview, type AiProductIntake } from "@noctella/shared";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { aiProductIntakesApi } from "@/lib/aiProductIntakes";
import { IntakePhotoSection } from "./IntakePhotoSection";
import { ProposalReviewSection } from "./ProposalReviewSection";
import { ApplyAndFinalizeSection } from "./ApplyAndFinalizeSection";
import { IntakeDangerZone } from "./IntakeDangerZone";

/**
 * Sprint 97: orchestrator only - loads intake/photos/proposal, holds the
 * authoritative refreshed state, and passes bounded slices + reload
 * callbacks to the four section components. A missing proposal (404) is
 * "not generated yet", never a page-level failure. Never displays raw actor
 * UUIDs - only lifecycle timestamps and the derived Product link.
 */
export default function AiProductIntakeDetailPage({ params }: { params: { id: string } }) {
  const [intake, setIntake] = useState<AiProductIntake | null>(null);
  const [photos, setPhotos] = useState<AiIntakePhoto[]>([]);
  const [proposal, setProposal] = useState<AiIntakeProposalReview | null>(null);
  const [proposalChecked, setProposalChecked] = useState(false);
  /** Sprint 97 correction: a genuine non-404 proposal-load failure, distinct from "not generated
   * yet" (proposal:null after a 404) and distinct from the page-level intake/photo load error.
   * Never thrown into the initial Promise.all - a proposal-load failure must not be represented
   * as an intake/photo failure, and must not make an otherwise-successful photo upload/delete
   * appear to fail. */
  const [proposalLoadError, setProposalLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reloadIntake = useCallback(async () => {
    const loaded = await aiProductIntakesApi.get(params.id);
    setIntake(loaded);
    return loaded;
  }, [params.id]);

  const reloadPhotos = useCallback(async () => {
    const loaded = await aiProductIntakesApi.listPhotos(params.id);
    setPhotos(loaded);
    return loaded;
  }, [params.id]);

  const reloadProposal = useCallback(async () => {
    try {
      const loaded = await aiProductIntakesApi.getProposal(params.id);
      setProposal(loaded);
      setProposalLoadError(null);
      return loaded;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setProposal(null);
        setProposalLoadError(null);
        return null;
      }
      // Non-404: never represented as absence. The last-known proposal object (if any) is left
      // untouched - only the dedicated load-error state changes, and this never throws into the
      // caller, so neither the initial page load nor a photo-mutation refresh is reported as
      // failed solely because this specific read failed.
      setProposalLoadError(err instanceof ApiError ? err.message : "Failed to load proposal");
      return null;
    } finally {
      setProposalChecked(true);
    }
  }, [params.id]);

  /** Sprint 97 correction (F1): a staged-photo upload/delete changes the server-side photo
   * fingerprint, which can make an existing proposal stale - always refresh both after a
   * successful photo mutation, not just the photo list, so ProposalReviewSection immediately
   * receives the current stale:true/false state instead of a locally-cached, now-incorrect value. */
  const refreshPhotosAndProposal = useCallback(async () => {
    const loadedPhotos = await reloadPhotos();
    await reloadProposal();
    return loadedPhotos;
  }, [reloadPhotos, reloadProposal]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([reloadIntake(), reloadPhotos(), reloadProposal()])
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load AI product intake"))
      .finally(() => setLoading(false));
  }, [reloadIntake, reloadPhotos, reloadProposal]);

  if (error && !intake) return <p style={{ color: "#c86a6a" }}>{error}</p>;
  if (loading || !intake || !proposalChecked) return <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading...</p>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>AI Product Intake</h1>
        <Link href="/ai-product-intakes" style={{ fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
          ← Back to AI Product Intake
        </Link>
      </div>
      <p style={{ color: "var(--noctella-aged-bronze)", fontSize: 13, marginTop: 4 }}>
        Status: <strong style={{ color: "var(--noctella-bright-star-gold)" }}>{intake.status}</strong>
      </p>
      <p style={{ fontSize: 13, marginTop: 4 }}>{describeNextAction(intake, photos, proposal)}</p>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      {error && <p style={{ color: "#c86a6a", marginBottom: 16 }}>{error}</p>}

      <div className="noctella-panel" style={{ padding: 16, marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>Lifecycle</h3>
        <Row label="Created" value={new Date(intake.createdAt).toLocaleString()} />
        {intake.cancelledAt && <Row label="Cancelled" value={new Date(intake.cancelledAt).toLocaleString()} />}
        {intake.appliedAt && <Row label="Applied" value={new Date(intake.appliedAt).toLocaleString()} />}
        {intake.finalizedAt && <Row label="Finalized" value={new Date(intake.finalizedAt).toLocaleString()} />}
        {intake.resultProductId && (
          <Row
            label="Product"
            value={
              <Link href={`/products/${intake.resultProductId}`} style={{ color: "var(--noctella-ivory)" }}>
                View Product →
              </Link>
            }
          />
        )}
      </div>

      <IntakePhotoSection intakeId={intake.id} intakeStatus={intake.status} photos={photos} onPhotosChanged={refreshPhotosAndProposal} />

      {proposalLoadError ? (
        <div className="noctella-panel" style={{ padding: 20, marginBottom: 20 }}>
          <h3 style={{ marginTop: 0 }}>Proposal Review</h3>
          <p style={{ color: "#c86a6a" }}>{proposalLoadError}</p>
          <button onClick={() => reloadProposal()} style={secondaryButtonStyle}>
            Reload proposal
          </button>
        </div>
      ) : (
        <ProposalReviewSection
          intakeId={intake.id}
          intakeStatus={intake.status}
          photos={photos}
          proposal={proposal}
          onProposalChanged={setProposal}
          onProposalReload={reloadProposal}
        />
      )}

      <ApplyAndFinalizeSection
        intakeId={intake.id}
        intake={intake}
        photos={photos}
        proposal={proposal}
        onIntakeChanged={reloadIntake}
        onPhotosReload={reloadPhotos}
      />

      <IntakeDangerZone intakeId={intake.id} intakeStatus={intake.status} onIntakeChanged={reloadIntake} />
    </div>
  );
}

function describeNextAction(intake: AiProductIntake, photos: AiIntakePhoto[], proposal: AiIntakeProposalReview | null): string {
  if (intake.status === AiProductIntakeStatus.Cancelled) {
    return "This intake is cancelled. Staged photos may still be removed, but no further proposal or apply actions are available.";
  }
  if (intake.status === AiProductIntakeStatus.Finalized) {
    return "This intake is finalized. Canonical photos have been created for the resulting Product.";
  }
  if (intake.status === AiProductIntakeStatus.Applied) {
    return "Product created as Draft. Select a Primary photo and finalize to create canonical photos.";
  }
  if (!proposal) return photos.length === 0 ? "Upload staged photos, then generate a proposal." : "Generate a proposal for this intake.";
  return "Review the generated proposal, then Save as Draft.";
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13 }}>
      <span style={{ color: "var(--noctella-aged-bronze)" }}>{label}</span>
      <span style={{ textAlign: "right" }}>{value}</span>
    </div>
  );
}

const secondaryButtonStyle: React.CSSProperties = {
  padding: "6px 10px",
  background: "transparent",
  color: "var(--noctella-ivory)",
  border: "1px solid var(--noctella-aged-bronze)",
  borderRadius: 4,
  cursor: "pointer",
};
