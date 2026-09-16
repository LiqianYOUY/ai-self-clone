import { FriendPlayRoom } from "@/components/play-app";

export default async function RoomPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <FriendPlayRoom roomId={id} />;
}
