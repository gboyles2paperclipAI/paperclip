import { useEffect, useState } from "react";

function isTabVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/**
 * Returns true while the browser tab is the active foreground tab.
 * Subscribes to visibilitychange so callers re-render immediately on tab show/hide.
 */
export function useTabVisible(): boolean {
  const [visible, setVisible] = useState(isTabVisible);

  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  return visible;
}

/**
 * Returns `interval` when the browser tab is visible, `false` when hidden.
 * Drop-in for a static `refetchInterval` value — pauses polling when the user
 * is not looking at the tab, reducing background load on the API server.
 *
 * When the tab becomes visible again the component re-renders with the real
 * interval, and TanStack Query resumes polling automatically.
 */
export function usePollingInterval(interval: number | false): number | false {
  const visible = useTabVisible();
  return visible ? interval : false;
}
