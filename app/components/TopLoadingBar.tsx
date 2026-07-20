import { useEffect, useRef, useState } from "react";
import { useFetchers, useNavigation, useRevalidator } from "react-router";

type Phase = "idle" | "loading" | "finishing";

/**
 * Thin progress bar across the top of the viewport while any global
 * data work is in flight: navigations, revalidations, or fetchers.
 */
export function TopLoadingBar() {
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const fetchers = useFetchers();

  const busy =
    navigation.state !== "idle" ||
    revalidator.state !== "idle" ||
    fetchers.some((f) => f.state !== "idle");

  const [phase, setPhase] = useState<Phase>("idle");
  const hideTimer = useRef<number | null>(null);

  useEffect(() => {
    if (busy) {
      if (hideTimer.current != null) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      setPhase("loading");
      return;
    }

    // Transitioned to idle — flash complete, then hide.
    setPhase((current) => {
      if (current === "idle") return "idle";
      if (hideTimer.current == null) {
        hideTimer.current = window.setTimeout(() => {
          setPhase("idle");
          hideTimer.current = null;
        }, 220);
      }
      return "finishing";
    });

    return () => {
      if (hideTimer.current != null) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };
  }, [busy]);

  if (phase === "idle") return null;

  return (
    <div
      className={`kmc-top-loading ${phase === "finishing" ? "kmc-top-loading--done" : ""}`}
      role="progressbar"
      aria-busy={phase === "loading"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Loading"
    >
      <div className="kmc-top-loading__bar" />
    </div>
  );
}
