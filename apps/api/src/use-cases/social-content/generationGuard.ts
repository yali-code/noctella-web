import { SocialContentGenerationConflictError } from "../../services/errors";

const requests = new Set<string>();
const products = new Set<string>();

/** Process-local only. The DB unique index prevents duplicates across instances,
 * but cannot prevent duplicate future provider work/billing across instances. */
export function acquireSocialGenerationGuard(requestId: string, productId: string): () => void {
  if (requests.has(requestId) || products.has(productId)) throw new SocialContentGenerationConflictError("in_progress");
  requests.add(requestId);
  products.add(productId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    requests.delete(requestId);
    products.delete(productId);
  };
}
