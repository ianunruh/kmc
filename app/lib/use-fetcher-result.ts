import { useEffect, useRef } from "react";

type FetcherState = "idle" | "loading" | "submitting";

/**
 * Run `onResult` once when a fetcher submission finishes (non-idle → idle
 * with data). Avoids toast spam from re-renders that leave fetcher.data set.
 */
export function useFetcherResult<T>(
  fetcher: { state: FetcherState; data?: T },
  onResult: (data: T) => void,
): void {
  const wasBusy = useRef(false);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  useEffect(() => {
    if (fetcher.state !== "idle") {
      wasBusy.current = true;
      return;
    }
    if (!wasBusy.current || fetcher.data == null) return;
    wasBusy.current = false;
    onResultRef.current(fetcher.data);
  }, [fetcher.state, fetcher.data]);
}
