import { ContentEditor } from "../ContentEditor";
export default function NewSocialContent({ searchParams }: { searchParams: { product?: string; media?: string } }) {
  return <ContentEditor initialProductId={typeof searchParams.product === "string" ? searchParams.product : null} initialMediaIds={typeof searchParams.media === "string" ? searchParams.media.split(",").filter(Boolean).slice(0, 10) : []} />;
}
