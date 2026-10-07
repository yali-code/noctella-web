"use client";
import { useCallback, useEffect, useState } from "react";
import type { SocialContent } from "@noctella/shared";
import { socialContentApi, type PublishingChain, type PublishingChainApproval, type PublishingReadiness } from "@/lib/socialContent";
import { ApiError } from "@/lib/api";
import { control, panel, statusLabel } from "./styles";

const when = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : "—";

/**
 * Scheduled Instagram publishing only. Every button is one explicit existing domain action:
 * prepare image, approve, create publish intent, schedule. There is deliberately no
 * "publish now", retry, resolve or cancel action here.
 */
export function PublishingWorkflow({ record, onRecordChange }: { record: SocialContent; onRecordChange: (value: SocialContent) => void }) {
  const [chain, setChain] = useState<PublishingChain | null>(null);
  const [readiness, setReadiness] = useState<PublishingReadiness | null | "unavailable">(null);
  const [photoId, setPhotoId] = useState(record.media[0]?.id ?? "");
  const [preparedImageId, setPreparedImageId] = useState("");
  const [publishAt, setPublishAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const value = await socialContentApi.publishingChain(record.id);
    setChain(value);
    setPreparedImageId((current) => current || value.preparedImages[0]?.id || "");
  }, [record.id]);
  useEffect(() => {
    load().catch(() => setError("Publishing status could not be loaded."));
    socialContentApi.publishingReadiness().then(setReadiness).catch(() => setReadiness("unavailable"));
  }, [load]);
  async function run(action: () => Promise<unknown>, reloadRecord = false) {
    setBusy(true); setError("");
    try {
      await action();
      if (reloadRecord) onRecordChange(await socialContentApi.get(record.id));
      await load();
    } catch (err) { setError(err instanceof ApiError ? err.message : "The action could not be completed. Reload and try again."); }
    finally { setBusy(false); }
  }
  const approval = chain?.approvals.find((item) => item.current) ?? null;
  return <section className="noctella-panel" style={panel} aria-label="Scheduled Instagram publishing">
    <h3>Scheduled Instagram publishing</h3>
    <Readiness value={readiness} />
    {error && <p role="alert">{error}</p>}
    {!chain ? <p role="status">Loading publishing status…</p> : <>
      {record.status === "ready_for_review" && <>
        <h4>1. Prepare image</h4>
        <p>Preparing an image does not approve, schedule or publish anything.</p>
        <label>Source photo <select style={control} value={photoId} onChange={(e) => setPhotoId(e.target.value)}>
          {record.media.map((photo) => <option key={photo.id} value={photo.id}>{photo.altText || photo.id}</option>)}
        </select></label>
        <button style={control} disabled={busy || !photoId} onClick={() => run(() => socialContentApi.prepareImage(record.id, photoId))}>Prepare image</button>
        <h4>2. Approve</h4>
        {!chain.preparedImages.length ? <p>Prepare an image before approval.</p> : <>
          <label>Prepared image <select style={control} value={preparedImageId} onChange={(e) => setPreparedImageId(e.target.value)}>
            {chain.preparedImages.map((image) => <option key={image.id} value={image.id}>{image.recipeVersion} · {image.sourcePhotoId}</option>)}
          </select></label>
          <p>Approval binds this exact caption and prepared image. It does not schedule or publish.</p>
          <button style={control} disabled={busy || !preparedImageId}
            onClick={() => run(() => socialContentApi.approve(record.id, preparedImageId, record.version), true)}>Approve with prepared image</button>
        </>}
      </>}
      {approval && <ApprovedSteps approval={approval} busy={busy} publishAt={publishAt} setPublishAt={setPublishAt} run={run} />}
      {record.status === "approved" && !approval && <p>No current Human Approval. This content cannot be scheduled.</p>}
      {chain.approvals.filter((item) => !item.current).map((item) => <p key={item.id}>Earlier approval {item.id} is no longer current.</p>)}
    </>}
  </section>;
}

function ApprovedSteps({ approval, busy, publishAt, setPublishAt, run }: {
  approval: PublishingChainApproval; busy: boolean; publishAt: string; setPublishAt: (value: string) => void;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  return <>
    <p>Human Approval: {when(approval.approvedAt)}</p>
    <h4>3. Publish intent</h4>
    {approval.intent ? <p>Publish intent recorded: {when(approval.intent.createdAt)}</p>
      : approval.attempt ? <p>This approval already has a publishing attempt, so it cannot be scheduled.</p>
        : <><p>Recording intent does not schedule or publish.</p>
          <button style={control} disabled={busy} onClick={() => run(() => socialContentApi.createPublishIntent(approval.id))}>Create publish intent</button></>}
    {approval.intent && <><h4>4. Schedule</h4>
      {approval.schedule ? <p>Scheduled for: {when(approval.schedule.requestedPublicationAt)}</p> : <>
        <label>Publication time <input style={control} type="datetime-local" value={publishAt} onChange={(e) => setPublishAt(e.target.value)} /></label>
        <p>The hourly scheduler picks up due posts, so publication can happen up to about an hour after this time.</p>
        <button style={control} disabled={busy || !publishAt}
          onClick={() => run(() => socialContentApi.schedulePublication(approval.intent!.id, new Date(publishAt).toISOString()))}>Schedule publication</button>
      </>}</>}
    {approval.schedule && <><h4>5. Execution</h4>
      <p>Execution: {approval.execution ? `started ${when(approval.execution.createdAt)}` : "waiting for the scheduler"}</p>
      {approval.job && <p>Background job: {statusLabel(approval.job.status)} · attempts {approval.job.attemptCount}/{approval.job.maxAttempts}{approval.job.lastError ? ` · ${approval.job.lastError}` : ""}</p>}
    </>}
    {approval.attempt && <Attempt attempt={approval.attempt} />}
  </>;
}

function Attempt({ attempt }: { attempt: NonNullable<PublishingChainApproval["attempt"]> }) {
  return <>
    <p>Instagram attempt ({attempt.origin}): {statusLabel(attempt.status)}{attempt.publishedAt ? ` · published ${when(attempt.publishedAt)}` : ""}{attempt.lastError ? ` · ${attempt.lastError}` : ""}</p>
    {attempt.requiresManualReconciliation && <p role="alert">Requires manual investigation. Publication may already have happened on Instagram. It will not be retried automatically, and this screen cannot retry or resolve it.</p>}
    {!attempt.requiresManualReconciliation && attempt.providerEntryState === "claimed" && attempt.status !== "published" && attempt.status !== "failed" &&
      <p>Instagram provider entry has started; publication can no longer be guaranteed to be prevented.</p>}
  </>;
}

function Readiness({ value }: { value: PublishingReadiness | null | "unavailable" }) {
  if (value === null) return <p role="status">Checking publishing readiness…</p>;
  if (value === "unavailable") return <p>Publishing readiness is not available for your role.</p>;
  return <div>
    <p>Publishing readiness: {value.ready ? "Ready" : "Not ready — scheduled posts will fail safely without publishing"}</p>
    <p>Instagram connection: {statusLabel(value.connection)}</p>
    {!value.mediaOriginAllowed && <p>Media origin is not allowed for Instagram.</p>}
    {!!value.missingConfiguration.length && <p>Missing or invalid configuration: {value.missingConfiguration.join(", ")}</p>}
  </div>;
}
