export const dynamic = "force-dynamic";

import { fetchErpIntegrationOverview, mapCapabilities, mapClientMetadata, mapFieldOwnership, mapReadOnlyLabel, mapVersionStatus } from "../../lib/erpIntegration";

export default async function ErpIntegrationPage() {
  const overview = await fetchErpIntegrationOverview();
  const clients = overview.clients.map(mapClientMetadata);
  return <main><h1>ERP Integration</h1><p>{mapReadOnlyLabel(overview.capabilities)}</p><section><h2>Status</h2><p>API {overview.version.apiVersion}: {mapVersionStatus(overview.version)}</p><p>Health: {overview.health.status} / DB {overview.health.database}</p><p>Client versions: min {overview.version.minimumSupportedErpClientVersion}, latest {overview.version.latestSupportedErpClientVersion}</p></section><section><h2>Configured clients</h2>{clients.length ? clients.map((c) => <p key={c.id}>{c.name} — key version {c.keyVersion} — last seen {c.lastSeenAt}</p>) : <p>Environment-key metadata only. Managed key issuance is deferred; raw secrets are never displayed.</p>}</section><section><h2>Capabilities</h2><ul>{mapCapabilities(overview.capabilities).map((m: { name: string; mode: string }) => <li key={m.name}>{m.name}: {m.mode}</li>)}</ul></section><section><h2>Checkpoint status</h2><p>{overview.checkpoints.length} recent acknowledgements</p></section><section><h2>Recent safe audit events</h2><p>{overview.audit.length} events; safe metadata only, no keys or customer payloads.</p></section><section><h2>Field ownership mapping</h2><p>{mapFieldOwnership(overview.mappingSummary).length} ERP fields mapped or explicitly deferred.</p></section></main>;
}
