/**
 * Sprint 55B: recursively extracts rendered text content from a React
 * element tree, without a DOM/testing-library dependency (none exists in
 * apps/admin yet, and installing one is out of scope for this sprint). Lets
 * tests assert on what an async Server Component would actually render.
 */
export function extractText(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join(" ");
  if (typeof node === "object" && node !== null && "type" in node) {
    const el = node as { type: unknown; props?: { children?: unknown } };
    // Function components (e.g. <ReportError message={...} />) render their
    // text from arbitrary props, not necessarily `children` - invoke them to
    // get their actual output instead of only walking `props.children`.
    if (typeof el.type === "function") return extractText((el.type as (props: unknown) => unknown)(el.props));
    return extractText(el.props?.children);
  }
  return "";
}

/** Sibling to extractText: collects every `href` prop found anywhere in the element tree, invoking function components along the way (same as extractText). */
export function extractHrefs(node: unknown): string[] {
  if (node == null || typeof node === "boolean" || typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap(extractHrefs);
  if (typeof node === "object" && node !== null && "type" in node) {
    const el = node as { type: unknown; props?: { children?: unknown; href?: unknown } };
    if (typeof el.type === "function") return extractHrefs((el.type as (props: unknown) => unknown)(el.props));
    const own = typeof el.props?.href === "string" ? [el.props.href] : [];
    return [...own, ...extractHrefs(el.props?.children)];
  }
  return [];
}
