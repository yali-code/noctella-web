import { ContentEditor } from "../ContentEditor";
export default function SocialContentDetail({ params }: { params: { id: string } }) {
  return <ContentEditor key={params.id} id={params.id} />;
}
