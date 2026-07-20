import { createFileRoute } from "@tanstack/react-router";
import { MotiChat } from "@/components/moti-chat";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  return <MotiChat />;
}
