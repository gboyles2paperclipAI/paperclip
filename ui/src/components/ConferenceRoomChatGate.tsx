import { Navigate, Outlet } from "@/lib/router";
import { useConferenceRoomChatEnabled } from "@/hooks/useConferenceRoomChatEnabled";
import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";

/**
 * Fallback UI when chat is disabled by VITE_CHAT_DISABLED env var.
 * Shows a graceful message with a contact support CTA.
 */
function ChatDisabledFallback() {
  return (
    <div data-testid="chat-disabled-fallback" className="flex h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <div className="mb-4 flex justify-center">
          <div className="rounded-lg bg-muted p-3">
            <AlertCircle className="h-8 w-8 text-muted-foreground" />
          </div>
        </div>
        <h2 className="mb-2 text-xl font-semibold">Chat Temporarily Unavailable</h2>
        <p className="mb-6 text-sm text-muted-foreground">
          We've temporarily disabled the chat feature for maintenance. Please try again
          in a few moments, or contact our support team if you need immediate assistance.
        </p>
        <div className="flex flex-col gap-2">
          <Button onClick={() => window.location.href = "/"} variant="default">
            Return to Dashboard
          </Button>
          <Button
            onClick={() => window.location.href = "mailto:support@help2day.tech"}
            variant="outline"
          >
            Contact Support
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Layout route guard for Conference Room Chat surfaces (PAP-136 / PAP-137).
 *
 * The gated routes stay registered (matching the PAP-89 streamlined-nav
 * precedent: gating is presentation-only, no 404 flash); when the
 * experimental flag is off or chat is disabled by env var, the element either
 * redirects to the company home (flag off) or shows a graceful fallback (disabled).
 * While the flag is still loading nothing renders so an enabled user is not
 * bounced away by a premature redirect.
 */
export function ConferenceRoomChatGate() {
  const { enabled, disabled, loaded } = useConferenceRoomChatEnabled();
  if (!loaded) return null;
  if (disabled) return <ChatDisabledFallback />;
  if (!enabled) return <Navigate to="/dashboard" replace />;
  return <Outlet />;
}
