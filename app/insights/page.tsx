import { redirect } from "next/navigation";

// Prioritize moved to the root — this keeps old /insights links working.
export default function InsightsRedirect() {
  redirect("/");
}
